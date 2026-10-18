import { EventEmitter } from "node:events";
import {
  effectiveStatus,
  sortStateByAttention,
  type AgentInfo,
  type AgentStatus,
  type HerdrState,
} from "@stream-deck-herdr/herdr-client";
import type { HostStatus } from "../hosts/HostConnection.js";
import type { HostRegistry } from "../hosts/HostRegistry.js";
import { ALL_HOSTS } from "../settings.js";

export interface AgentRef {
  hostId: string;
  hostLabel: string;
  agent: AgentInfo;
  state: HerdrState;
}

export interface HostView {
  hostId: string;
  label: string;
  state: HerdrState | null;
  status: HostStatus;
}

const RANK: Record<AgentStatus, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

/**
 * Read model over every connected host: attention-sorted agent lists and
 * lookups by pane id / session id. Emits `change` (coalesced per tick).
 */
export class AgentStore extends EventEmitter {
  private states = new Map<string, HerdrState>();
  private statuses = new Map<string, HostStatus>();
  private changeScheduled = false;

  constructor(private readonly registry: HostRegistry) {
    super();
    registry.on("agents", (hostId: string, state: HerdrState) => {
      this.states.set(hostId, state);
      this.scheduleChange();
    });
    registry.on("status", (hostId: string, status: HostStatus) => {
      this.statuses.set(hostId, status);
      if (status.state === "stopped") this.states.delete(hostId);
      this.scheduleChange();
    });
    registry.on("hosts", () => {
      for (const id of [...this.states.keys()]) if (!registry.host(id)) this.states.delete(id);
      for (const id of [...this.statuses.keys()]) if (!registry.host(id)) this.statuses.delete(id);
      this.scheduleChange();
    });
  }

  hostCount(): number {
    return this.registry.hosts().length;
  }

  hostLabel(hostId: string): string {
    if (hostId === ALL_HOSTS) return "All hosts";
    return this.registry.host(hostId)?.label ?? hostId;
  }

  host(hostId: string): HostView | undefined {
    const config = this.registry.host(hostId);
    if (!config) return undefined;
    return {
      hostId,
      label: config.label,
      state: this.states.get(hostId) ?? null,
      status: this.statuses.get(hostId) ?? { state: "connecting", error: null, retryInMs: null },
    };
  }

  /** Agents of one host (or all hosts) in attention order. */
  sorted(hostId: string): AgentRef[] {
    const hostIds = hostId === ALL_HOSTS ? this.registry.hosts().map((h) => h.id) : [hostId];
    const perHost = hostIds.map((id, hostIndex) => {
      const state = this.states.get(id);
      if (!state) return [];
      const label = this.hostLabel(id);
      return sortStateByAttention(state).map((agent, index) => ({
        ref: { hostId: id, hostLabel: label, agent, state } as AgentRef,
        hostIndex,
        index,
      }));
    });
    if (perHost.length === 1) return perHost[0]!.map((x) => x.ref);
    return perHost
      .flat()
      .sort((a, b) => {
        const sa = effectiveStatus(a.ref.agent);
        const sb = effectiveStatus(b.ref.agent);
        if (RANK[sa] !== RANK[sb]) return RANK[sa] - RANK[sb];
        if (sa === "blocked") {
          const diff = (a.ref.agent.state_change_seq ?? 0) - (b.ref.agent.state_change_seq ?? 0);
          if (diff !== 0) return diff;
        }
        if (a.hostIndex !== b.hostIndex) return a.hostIndex - b.hostIndex;
        return a.index - b.index;
      })
      .map((x) => x.ref);
  }

  /** Finds an agent by pane id, falling back to its native session id. */
  find(hostId: string, paneId: string | undefined, sessionId?: string): AgentRef | undefined {
    const state = this.states.get(hostId);
    if (!state) return undefined;
    const label = this.hostLabel(hostId);
    const byPane = paneId ? state.agents.find((a) => a.pane_id === paneId) : undefined;
    const bySession = !byPane && sessionId ? state.agents.find((a) => a.agent_session?.value === sessionId) : undefined;
    const agent = byPane ?? bySession;
    return agent ? { hostId, hostLabel: label, agent, state } : undefined;
  }

  /** Message describing why a host has no data, or null when it is online. */
  offlineMessage(hostId: string): string | null {
    if (hostId === ALL_HOSTS) {
      const hosts = this.registry.hosts();
      if (hosts.length === 0) return "no hosts configured";
      if (hosts.some((h) => this.states.has(h.id))) return null;
      const first = this.statuses.get(hosts[0]!.id);
      return first?.error ?? "connecting…";
    }
    const view = this.host(hostId);
    if (!view) return "host not found";
    if (view.state) return null;
    return view.status.error ?? (view.status.state === "connecting" ? "connecting…" : "not connected");
  }

  private scheduleChange(): void {
    if (this.changeScheduled) return;
    this.changeScheduled = true;
    queueMicrotask(() => {
      this.changeScheduled = false;
      this.emit("change");
    });
  }
}
