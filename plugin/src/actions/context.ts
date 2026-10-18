import type { Logger } from "../hosts/HostConnection.js";
import type { HostRegistry } from "../hosts/HostRegistry.js";
import type { GlobalSettings, HostConfig } from "../settings.js";
import type { AgentStore } from "../store/AgentStore.js";

/** Shared services handed to every action. */
export interface PluginContext {
  registry: HostRegistry;
  store: AgentStore;
  logger: Logger;
  loadGlobalSettings(): Promise<GlobalSettings>;
  saveHosts(hosts: HostConfig[]): Promise<void>;
}
