import { EventEmitter } from "node:events";
import {
  AgentWatcher,
  HostKeyChangedError,
  SshTransport,
  requestOnce,
  type HerdrState,
  type Transport,
  type WatcherStatus,
} from "@stream-deck-herdr/herdr-client";
import type { HostConfig } from "../settings.js";
import { LocalResolvingTransport } from "./localResolvingTransport.js";

export type Logger = Pick<Console, "debug" | "info" | "warn" | "error">;

export interface HostStatus {
  state: WatcherStatus["state"];
  error: string | null;
  retryInMs: number | null;
}

export interface TestResult {
  ok: boolean;
  message: string;
  fingerprint?: string;
  socketPath?: string;
}

export function createTransport(config: HostConfig, logger: Logger): Transport {
  if (config.mode === "local") {
    return new LocalResolvingTransport(
      {
        session: config.session || undefined,
        socketPath: config.socketPath || undefined,
        herdrBinary: config.herdrBinary || undefined,
      },
      config.label,
    );
  }
  return new SshTransport(
    {
      host: config.host,
      port: config.port || undefined,
      auth: config.auth,
      remoteSession: config.remoteSession || undefined,
      remoteSocketPath: config.remoteSocketPath || undefined,
      knownHostKey: config.knownHostKey || undefined,
      label: config.label,
    },
    { logger },
  );
}

/**
 * One configured Herdr host: owns the transport and the agent watcher.
 *
 * Events: `agents` (HerdrState), `status` (HostStatus), `hostkey` (fingerprint).
 */
export class HostConnection extends EventEmitter {
  readonly id: string;
  private watcher: AgentWatcher | null = null;
  private _status: HostStatus = { state: "stopped", error: null, retryInMs: null };

  constructor(
    readonly config: HostConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.id = config.id;
  }

  get label(): string {
    return this.config.label;
  }

  get state(): HerdrState | null {
    return this.watcher?.state ?? null;
  }

  get status(): HostStatus {
    return this._status;
  }

  start(): void {
    if (this.watcher) return;
    const transport = createTransport(this.config, this.logger);
    transport.on("hostkey", (fingerprint: string) => this.emit("hostkey", fingerprint));
    const watcher = new AgentWatcher(transport, { logger: this.logger });
    watcher.on("agents", (state: HerdrState) => this.emit("agents", state));
    watcher.on("status", (status: WatcherStatus) => {
      const error = status.error;
      this._status = {
        state: status.state,
        error: error
          ? error instanceof HostKeyChangedError
            ? `${error.message}. Reset the host key in the inspector.`
            : error.message
          : null,
        retryInMs: status.retryInMs,
      };
      this.emit("status", this._status);
    });
    this.watcher = watcher;
    watcher.start();
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.stop();
    this._status = { state: "stopped", error: null, retryInMs: null };
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.watcher) return Promise.reject(new Error(`${this.label} is not started`));
    return this.watcher.request<T>(method, params);
  }

  /** Opens a throw-away connection and pings the Herdr server. */
  static async test(config: HostConfig, logger: Logger): Promise<TestResult> {
    const transport = createTransport(config, logger);
    let fingerprint: string | undefined;
    transport.on("hostkey", (fp: string) => (fingerprint = fp));
    try {
      const started = Date.now();
      const result = await requestOnce<{ type?: string }>(transport, "ping", {}, 15_000);
      const snapshot = await requestOnce<{ snapshot?: { agents?: unknown[]; version?: string } }>(
        transport,
        "session.snapshot",
        {},
        15_000,
      );
      const agents = snapshot.snapshot?.agents?.length ?? 0;
      const version = snapshot.snapshot?.version ?? "?";
      const socketPath = transport instanceof LocalResolvingTransport ? (transport.socketPath ?? undefined) : undefined;
      return {
        ok: result?.type === "pong",
        message: `Connected to Herdr ${version} in ${Date.now() - started}ms · ${agents} agent${agents === 1 ? "" : "s"}`,
        fingerprint,
        socketPath,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message, fingerprint };
    } finally {
      await transport.dispose();
    }
  }
}
