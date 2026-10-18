import { EventEmitter } from "node:events";
import type { HerdrState } from "@stream-deck-herdr/herdr-client";
import { ALL_HOSTS, type HostConfig } from "../settings.js";
import { HostConnection, type HostStatus, type Logger } from "./HostConnection.js";

const STOP_GRACE_MS = 3_000;

/**
 * Keeps one {@link HostConnection} per configured host that is referenced by
 * at least one visible action. Consumers (action contexts) acquire a host id
 * or {@link ALL_HOSTS}; unreferenced hosts are stopped after a grace period.
 *
 * Events: `agents` (hostId, state), `status` (hostId, status),
 * `hostkey` (hostId, fingerprint), `hosts` (configs).
 */
export class HostRegistry extends EventEmitter {
  private configs = new Map<string, HostConfig>();
  private order: string[] = [];
  private connections = new Map<string, HostConnection>();
  private consumers = new Map<string, string>(); // consumerId -> hostId | ALL_HOSTS
  private stopTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly logger: Logger) {
    super();
  }

  hosts(): HostConfig[] {
    return this.order.map((id) => this.configs.get(id)).filter((h): h is HostConfig => Boolean(h));
  }

  host(hostId: string): HostConfig | undefined {
    return this.configs.get(hostId);
  }

  get(hostId: string): HostConnection | undefined {
    return this.connections.get(hostId);
  }

  setConfigs(hosts: HostConfig[]): void {
    const next = new Map<string, HostConfig>();
    for (const host of hosts) if (host?.id) next.set(host.id, host);
    const changed: string[] = [];
    for (const [id, config] of next) {
      const prev = this.configs.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(config)) changed.push(id);
    }
    for (const id of this.configs.keys()) if (!next.has(id)) changed.push(id);
    this.configs = next;
    this.order = hosts.map((h) => h.id);
    for (const id of changed) {
      const conn = this.connections.get(id);
      if (conn) {
        this.connections.delete(id);
        void conn.stop();
        const stopped: HostStatus = { state: "stopped", error: null, retryInMs: null };
        this.emit("status", id, stopped);
      }
    }
    this.sync();
    this.emit("hosts", this.hosts());
  }

  acquire(consumerId: string, hostId: string): void {
    this.consumers.set(consumerId, hostId);
    this.sync();
  }

  release(consumerId: string): void {
    if (this.consumers.delete(consumerId)) this.sync();
  }

  async stopAll(): Promise<void> {
    for (const timer of this.stopTimers.values()) clearTimeout(timer);
    this.stopTimers.clear();
    const conns = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(conns.map((c) => c.stop()));
  }

  private isWanted(hostId: string): boolean {
    for (const wanted of this.consumers.values()) {
      if (wanted === ALL_HOSTS || wanted === hostId) return true;
    }
    return false;
  }

  private sync(): void {
    for (const [id, config] of this.configs) {
      const wanted = this.isWanted(id);
      const existing = this.connections.get(id);
      if (wanted) {
        const timer = this.stopTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.stopTimers.delete(id);
        }
        if (!existing) this.startHost(config);
      } else if (existing && !this.stopTimers.has(id)) {
        this.stopTimers.set(
          id,
          setTimeout(() => {
            this.stopTimers.delete(id);
            if (this.isWanted(id)) return;
            const conn = this.connections.get(id);
            this.connections.delete(id);
            void conn?.stop();
            this.logger.info(`[herdr] stopped unused host ${config.label}`);
          }, STOP_GRACE_MS),
        );
      }
    }
    for (const [id, conn] of this.connections) {
      if (!this.configs.has(id)) {
        this.connections.delete(id);
        void conn.stop();
      }
    }
  }

  private startHost(config: HostConfig): void {
    const conn = new HostConnection(config, this.logger);
    conn.on("agents", (state: HerdrState) => this.emit("agents", config.id, state));
    conn.on("status", (status: HostStatus) => this.emit("status", config.id, status));
    conn.on("hostkey", (fingerprint: string) => this.emit("hostkey", config.id, fingerprint));
    this.connections.set(config.id, conn);
    this.logger.info(`[herdr] starting host ${config.label} (${config.mode})`);
    conn.start();
  }
}
