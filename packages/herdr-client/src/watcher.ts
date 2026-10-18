import { EventEmitter } from "node:events";
import { HerdrConnection, HerdrError, requestOnce } from "./socket.js";
import type { Transport } from "./transport.js";
import type {
  AgentInfo,
  HerdrState,
  PaneAgentStatusChangedData,
  PaneInfo,
  PushedEvent,
  SessionSnapshot,
  Subscription,
} from "./types.js";

export type WatcherConnectionState = "stopped" | "connecting" | "online" | "offline";

export interface WatcherStatus {
  state: WatcherConnectionState;
  error: Error | null;
  /** Milliseconds until the next reconnect attempt, when offline. */
  retryInMs: number | null;
}

export interface AgentWatcherOptions {
  /** Interval of the reconciliation `session.snapshot` read. 0 disables it. */
  pollIntervalMs?: number;
  /** Debounce for coalescing refreshes triggered by events. */
  refreshDebounceMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

const GLOBAL_SUBSCRIPTIONS: Subscription[] = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.updated" },
  { type: "pane.exited" },
  { type: "pane.moved" },
  { type: "pane.agent_detected" },
  { type: "pane.focused" },
  { type: "workspace.created" },
  { type: "workspace.renamed" },
  { type: "workspace.moved" },
  { type: "workspace.reordered" },
  { type: "workspace.closed" },
  { type: "tab.created" },
  { type: "tab.renamed" },
  { type: "tab.moved" },
  { type: "tab.closed" },
];

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Keeps an up-to-date view of the agents in one Herdr session.
 *
 * Opens a request connection, a global lifecycle subscription and a per-pane
 * `pane.agent_status_changed` subscription (re-opened whenever the set of
 * agent panes changes), reconciles periodically, and reconnects with backoff.
 *
 * Events:
 * - `agents` (state: HerdrState): the view changed.
 * - `status` (status: WatcherStatus): connection state changed.
 */
export class AgentWatcher extends EventEmitter {
  private readonly opts: Required<Omit<AgentWatcherOptions, "logger">> & { logger: NonNullable<AgentWatcherOptions["logger"]> };
  private running = false;
  private generation = 0;
  private globalSub: HerdrConnection | null = null;
  private statusSub: HerdrConnection | null = null;
  private statusSubKey = "";
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private backoffMs: number;
  private _state: HerdrState | null = null;
  private _status: WatcherStatus = { state: "stopped", error: null, retryInMs: null };

  constructor(
    readonly transport: Transport,
    options: AgentWatcherOptions = {},
  ) {
    super();
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? 30_000,
      refreshDebounceMs: options.refreshDebounceMs ?? 150,
      reconnectMinMs: options.reconnectMinMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      logger: options.logger ?? noopLogger,
    };
    this.backoffMs = this.opts.reconnectMinMs;
    transport.on("close", (err?: Error) => {
      if (this.running) this.onLinkLost(err ?? new HerdrError("transport_closed", "transport closed"));
    });
  }

  get state(): HerdrState | null {
    return this._state;
  }

  get status(): WatcherStatus {
    return this._status;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.backoffMs = this.opts.reconnectMinMs;
    void this.connectAll();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    this.teardownConnections();
    this.setStatus({ state: "stopped", error: null, retryInMs: null });
    await this.transport.dispose();
  }

  /**
   * Sends one request to the session. Herdr serves one request per
   * connection, so a fresh connection is opened each time.
   */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this._status.state !== "online") {
      throw new HerdrError("offline", `${this.transport.label} is not connected`);
    }
    return requestOnce<T>(this.transport, method, params, timeoutMs ?? this.opts.requestTimeoutMs);
  }

  /** Forces a reconciliation read; coalesced with any in-flight refresh. */
  refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    const generation = this.generation;
    this.refreshInFlight = (async () => {
      try {
        do {
          this.refreshQueued = false;
          const snapshot = await requestOnce<{ snapshot: SessionSnapshot }>(
            this.transport,
            "session.snapshot",
            {},
            this.opts.requestTimeoutMs,
          );
          if (generation !== this.generation) return;
          this.applySnapshot(snapshot.snapshot);
          await this.ensureStatusSubscription(generation);
        } while (this.refreshQueued && generation === this.generation);
      } catch (err) {
        if (generation === this.generation && this.running) {
          this.onLinkLost(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  // ---------------------------------------------------------------------------

  private async connectAll(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    this.setStatus({ state: "connecting", error: this._status.error, retryInMs: null });
    try {
      const snapshot = await requestOnce<{ snapshot: SessionSnapshot }>(
        this.transport,
        "session.snapshot",
        {},
        this.opts.requestTimeoutMs,
      );
      if (generation !== this.generation) return;

      const globalSub = await HerdrConnection.open(this.transport);
      if (generation !== this.generation) return globalSub.close();
      this.globalSub = globalSub;
      globalSub.on("event", (event: PushedEvent) => this.onEvent(event));
      globalSub.on("close", (err?: Error) => this.onConnectionClosed(generation, "global", err));
      await globalSub.subscribe(GLOBAL_SUBSCRIPTIONS, this.opts.requestTimeoutMs);
      if (generation !== this.generation) return;

      this.applySnapshot(snapshot.snapshot);
      await this.ensureStatusSubscription(generation);
      if (generation !== this.generation) return;

      this.backoffMs = this.opts.reconnectMinMs;
      this.setStatus({ state: "online", error: null, retryInMs: null });
      this.schedulePoll();
      // Events may have arrived while subscriptions were being set up.
      this.scheduleRefresh();
    } catch (err) {
      if (generation !== this.generation) return;
      this.onLinkLost(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onConnectionClosed(generation: number, which: string, err?: Error): void {
    if (generation !== this.generation || !this.running) return;
    this.opts.logger.warn(`[herdr] ${this.transport.label}: ${which} connection closed${err ? `: ${err.message}` : ""}`);
    this.onLinkLost(err ?? new HerdrError("connection_closed", `${which} connection closed`));
  }

  private onLinkLost(err: Error): void {
    if (!this.running) return;
    this.generation += 1;
    this.clearTimers();
    this.teardownConnections();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.reconnectMaxMs);
    this.opts.logger.warn(`[herdr] ${this.transport.label}: offline (${err.message}); retrying in ${delay}ms`);
    this.setStatus({ state: "offline", error: err, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectAll();
    }, delay);
  }

  private teardownConnections(): void {
    for (const conn of [this.globalSub, this.statusSub]) {
      conn?.removeAllListeners("close");
      conn?.close();
    }
    this.globalSub = null;
    this.statusSub = null;
    this.statusSubKey = "";
    this.refreshInFlight = null;
    this.refreshQueued = false;
  }

  private clearTimers(): void {
    for (const timer of [this.pollTimer, this.refreshTimer, this.reconnectTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.pollTimer = null;
    this.refreshTimer = null;
    this.reconnectTimer = null;
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.opts.pollIntervalMs <= 0) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh().finally(() => {
        if (this.running && this._status.state === "online") this.schedulePoll();
      });
    }, this.opts.pollIntervalMs);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, this.opts.refreshDebounceMs);
  }

  private applySnapshot(snapshot: SessionSnapshot): void {
    this._state = {
      agents: snapshot.agents ?? [],
      workspaces: snapshot.workspaces ?? [],
      tabs: snapshot.tabs ?? [],
      focusedPaneId: snapshot.focused_pane_id ?? null,
      serverVersion: snapshot.version ?? null,
    };
    this.emit("agents", this._state);
  }

  /** Re-opens the per-pane status subscription when the set of agent panes changed. */
  private async ensureStatusSubscription(generation: number): Promise<void> {
    const paneIds = (this._state?.agents ?? []).map((a) => a.pane_id).sort();
    const key = paneIds.join(",");
    if (key === this.statusSubKey) return;

    const previous = this.statusSub;
    if (paneIds.length === 0) {
      this.statusSub = null;
      this.statusSubKey = "";
      previous?.removeAllListeners("close");
      previous?.close();
      return;
    }

    const next = await HerdrConnection.open(this.transport);
    if (generation !== this.generation) return next.close();
    next.on("event", (event: PushedEvent) => this.onEvent(event));
    try {
      await next.subscribe(
        paneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id }) as Subscription),
        this.opts.requestTimeoutMs,
      );
    } catch (err) {
      next.close();
      if (err instanceof HerdrError && err.code === "not_found") {
        // A pane vanished between snapshot and subscribe; the next refresh fixes it.
        this.scheduleRefresh();
        return;
      }
      throw err;
    }
    if (generation !== this.generation) return next.close();
    next.on("close", (err?: Error) => this.onConnectionClosed(generation, "status", err));
    this.statusSub = next;
    this.statusSubKey = key;
    previous?.removeAllListeners("close");
    previous?.close();
  }

  private onEvent(event: PushedEvent): void {
    if (!this._state) return;
    switch (event.event) {
      case "pane_agent_status_changed": {
        const data = event.data as unknown as PaneAgentStatusChangedData;
        const agent = this._state.agents.find((a) => a.pane_id === data.pane_id);
        if (agent && agent.agent_status !== data.agent_status) {
          agent.agent_status = data.agent_status;
          if (data.agent_status !== "idle") delete agent.completion_seq;
          this.emit("agents", this._state);
        }
        // Pull authoritative fields (state_change_seq, completion_seq, …).
        this.scheduleRefresh();
        return;
      }
      case "pane_updated": {
        const pane = (event.data as { pane?: PaneInfo }).pane;
        if (pane) this.applyPaneUpdate(pane);
        return;
      }
      case "pane_focused": {
        const paneId = (event.data as { pane_id?: string }).pane_id;
        if (this._state && paneId) {
          this._state.focusedPaneId = paneId;
          for (const agent of this._state.agents) agent.focused = agent.pane_id === paneId;
          this.emit("agents", this._state);
        }
        return;
      }
      default:
        this.scheduleRefresh();
    }
  }

  private applyPaneUpdate(pane: PaneInfo): void {
    if (!this._state) return;
    const index = this._state.agents.findIndex((a) => a.pane_id === pane.pane_id);
    if (index >= 0 && pane.agent) {
      // Known agent: merge the authoritative pane fields in place.
      this._state.agents[index] = { ...this._state.agents[index], ...pane, agent: pane.agent } as AgentInfo;
      this.emit("agents", this._state);
      return;
    }
    if (index >= 0 || pane.agent) {
      // Membership may have changed (agent appeared or left); the snapshot is
      // authoritative on which panes count as agents.
      this.scheduleRefresh();
    }
  }

  private setStatus(status: WatcherStatus): void {
    this._status = status;
    this.emit("status", status);
  }
}
