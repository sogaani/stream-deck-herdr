import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { LocalTransport } from "../src/localTransport.js";
import type { AgentInfo, SessionSnapshot, Subscription, TabInfo, WorkspaceInfo } from "../src/types.js";

export interface FakeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface SubscriberHandle {
  subscriptions: Subscription[];
  push(event: string, data: Record<string, unknown>): void;
  fail(code: string, message: string): void;
  close(): void;
}

export function makeAgent(overrides: Partial<AgentInfo> & { pane_id: string }): AgentInfo {
  const [workspace_id = "w1"] = overrides.pane_id.split(":");
  return {
    agent: "claude",
    agent_status: "idle",
    terminal_id: `term_${overrides.pane_id}`,
    workspace_id,
    tab_id: `${workspace_id}:t1`,
    focused: false,
    revision: 1,
    ...overrides,
  };
}

export function makeWorkspace(workspace_id: string, label = workspace_id): WorkspaceInfo {
  return { workspace_id, label, focused: false, number: Number(workspace_id.slice(1)) };
}

export function makeTab(tab_id: string, label = tab_id): TabInfo {
  const [workspace_id = "w1"] = tab_id.split(":");
  return { tab_id, workspace_id, label, focused: false };
}

/**
 * Minimal Herdr socket server for tests. Mimics the real wire behaviour:
 * one request per connection (closed after the response) except for
 * `events.subscribe`, which stays open and receives pushed events.
 */
export class FakeHerdr extends EventEmitter {
  readonly dir = mkdtempSync(path.join(os.tmpdir(), "fake-herdr-"));
  readonly socketPath = process.platform === "win32" ? `\\\\.\\pipe\\fake-herdr-${process.pid}-${Date.now()}` : path.join(this.dir, "herdr.sock");
  readonly requests: FakeRequest[] = [];
  readonly subscribers = new Set<SubscriberHandle>();
  snapshot: SessionSnapshot = { agents: [], workspaces: [], tabs: [], panes: [] };
  /** Custom handlers per method; return a result or throw `{code,message}`. */
  handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  /** Methods the server never answers (connection left open). */
  hang = new Set<string>();
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();

  async start(): Promise<void> {
    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  transport(label = "fake"): LocalTransport {
    return new LocalTransport(this.socketPath, label);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Pushes an event to every subscriber whose subscriptions match `type`. */
  broadcast(type: string, data: Record<string, unknown>): void {
    const event = type.replace(/\./g, "_");
    for (const sub of this.subscribers) {
      const matches = sub.subscriptions.some((s) => {
        if (s.type !== type) return false;
        if ("pane_id" in s && s.pane_id && data.pane_id !== s.pane_id) return false;
        return true;
      });
      if (matches) sub.push(event, { ...data, type: event });
    }
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.onRequest(socket, JSON.parse(line) as FakeRequest);
        nl = buffer.indexOf("\n");
      }
    });
  }

  private onRequest(socket: Duplex & net.Socket, request: FakeRequest): void {
    this.requests.push(request);
    this.emit("request", request);
    if (this.hang.has(request.method)) return;
    const reply = (payload: unknown) => socket.write(`${JSON.stringify(payload)}\n`);

    if (request.method === "events.subscribe") {
      const subscriptions = (request.params.subscriptions ?? []) as Subscription[];
      const knownPanes = new Set(this.snapshot.panes.map((p) => p.pane_id).concat(this.snapshot.agents.map((a) => a.pane_id)));
      const missing = subscriptions.find((s) => "pane_id" in s && s.pane_id && !knownPanes.has(s.pane_id));
      if (missing) {
        reply({ id: request.id, error: { code: "not_found", message: `pane not found: ${(missing as { pane_id: string }).pane_id}` } });
        socket.end();
        return;
      }
      const handle: SubscriberHandle = {
        subscriptions,
        push: (event, data) => reply({ event, data }),
        fail: (code, message) => {
          reply({ id: request.id, error: { code, message } });
          socket.end();
        },
        close: () => socket.end(),
      };
      this.subscribers.add(handle);
      socket.once("close", () => this.subscribers.delete(handle));
      reply({ id: request.id, result: { type: "subscription_started" } });
      this.emit("subscribed", handle);
      return;
    }

    try {
      let result: unknown;
      const handler = this.handlers.get(request.method);
      if (handler) {
        result = handler(request.params);
      } else if (request.method === "ping") {
        result = { type: "pong" };
      } else if (request.method === "session.snapshot") {
        result = { type: "session_snapshot", snapshot: structuredClone(this.snapshot) };
      } else if (request.method === "agent.list") {
        result = { type: "agent_list", agents: structuredClone(this.snapshot.agents) };
      } else if (request.method === "agent.get") {
        const agent = this.snapshot.agents.find((a) => a.pane_id === request.params.target);
        if (!agent) throw { code: "not_found", message: "agent not found" };
        result = { type: "agent_info", agent: structuredClone(agent) };
      } else {
        throw { code: "unknown_method", message: `unknown method ${request.method}` };
      }
      reply({ id: request.id, result });
    } catch (err) {
      const body = err as { code?: string; message?: string };
      reply({ id: request.id, error: { code: body.code ?? "internal", message: body.message ?? String(err) } });
    }
    socket.end();
  }
}

export function waitFor<T>(emitter: EventEmitter, event: string, predicate: (value: T) => boolean = () => true, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(value);
    };
    emitter.on(event, listener);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
