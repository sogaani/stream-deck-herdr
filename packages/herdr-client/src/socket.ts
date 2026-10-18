import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import type { Transport } from "./transport.js";
import type { HerdrErrorBody, PushedEvent, Subscription } from "./types.js";

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

let connectionSeq = 0;

/**
 * Herdr answers one request per connection and then closes it (only
 * `events.subscribe` keeps a connection open). This opens a connection, sends
 * one request and tears the connection down.
 */
export async function requestOnce<T = unknown>(
  transport: Transport,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<T> {
  const conn = await HerdrConnection.open(transport);
  try {
    return await conn.request<T>(method, params, timeoutMs);
  } finally {
    conn.close();
  }
}

/**
 * One newline-delimited JSON connection to the Herdr API.
 *
 * Events:
 * - `event` ({@link PushedEvent}): a pushed subscription event.
 * - `close` (err?: Error): the connection ended. `err` is a {@link HerdrError}
 *   with code `events_lost` when the server dropped a subscription.
 */
export class HerdrConnection extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private requestSeq = 0;
  private closed = false;
  private readonly prefix: string;

  private constructor(
    private readonly stream: Duplex,
    readonly label: string,
  ) {
    super();
    this.prefix = `sd${process.pid.toString(36)}_${(++connectionSeq).toString(36)}`;
    stream.on("data", (chunk: Buffer | string) => this.onData(chunk));
    stream.once("error", (err: Error) => this.handleClose(err));
    stream.once("close", () => this.handleClose());
    stream.once("end", () => this.handleClose());
  }

  static async open(transport: Transport): Promise<HerdrConnection> {
    const stream = await transport.connect();
    return new HerdrConnection(stream, transport.label);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends one request and resolves with its `result`. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new HerdrError("connection_closed", `connection to ${this.label} is closed`));
    }
    const id = `${this.prefix}_${++this.requestSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new HerdrError("timeout", `${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  /**
   * Turns this connection into a subscription stream. Resolves once the
   * server acknowledges with `subscription_started`; events are then emitted
   * as `event`.
   */
  async subscribe(subscriptions: Subscription[], timeoutMs = 10_000): Promise<void> {
    const result = await this.request<{ type?: string }>("events.subscribe", { subscriptions }, timeoutMs);
    if (result?.type !== "subscription_started") {
      throw new HerdrError("unexpected_response", `events.subscribe returned ${JSON.stringify(result)}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.stream.destroy();
    this.handleClose();
  }

  private write(message: unknown): void {
    try {
      this.stream.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.handleClose(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("protocol_error", new HerdrError("invalid_json", `unparseable line from ${this.label}`));
      return;
    }

    if (typeof message.event === "string") {
      this.emit("event", message as unknown as PushedEvent);
      return;
    }

    const id = typeof message.id === "string" ? message.id : "";
    const pending = this.pending.get(id);
    const error = message.error as HerdrErrorBody | undefined;
    if (pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (error) {
        pending.reject(new HerdrError(error.code, error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (error) {
      // An error for an already-acknowledged request: the server is dropping
      // this subscription (e.g. `events_lost`) and will close the connection.
      this.handleClose(new HerdrError(error.code, error.message));
    }
  }

  private handleClose(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const reason = err ?? new HerdrError("connection_closed", `connection to ${this.label} closed`);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.stream.destroy();
    this.emit("close", err);
  }
}
