import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { AgentAction } from "./actions/AgentAction.js";
import type { PluginContext } from "./actions/context.js";
import { AgentDialAction } from "./actions/DialAction.js";
import { SlotAction } from "./actions/SlotAction.js";
import { HostRegistry } from "./hosts/HostRegistry.js";
import type { GlobalSettings, HostConfig } from "./settings.js";
import { AgentStore } from "./store/AgentStore.js";

const logger = streamDeck.logger.createScope("herdr");

const registry = new HostRegistry(logger);
const store = new AgentStore(registry);

async function loadGlobalSettings(): Promise<GlobalSettings> {
  const settings = (await streamDeck.settings.getGlobalSettings()) as unknown as GlobalSettings;
  return { hosts: Array.isArray(settings?.hosts) ? settings.hosts : [] };
}

async function saveHosts(hosts: HostConfig[]): Promise<void> {
  const current = (await streamDeck.settings.getGlobalSettings()) as unknown as GlobalSettings;
  await streamDeck.settings.setGlobalSettings({ ...current, hosts } as unknown as JsonObject);
  // Stream Deck does not echo our own change back to the plugin.
  registry.setConfigs(hosts);
}

const ctx: PluginContext = { registry, store, logger, loadGlobalSettings, saveHosts };

// Persist SSH host keys learned on first connection (trust on first use).
registry.on("hostkey", (hostId: string, fingerprint: string) => {
  void (async () => {
    const { hosts = [] } = await loadGlobalSettings();
    const next = hosts.map((h) => (h.id === hostId && h.mode === "ssh" && !h.knownHostKey ? { ...h, knownHostKey: fingerprint } : h));
    if (JSON.stringify(next) !== JSON.stringify(hosts)) {
      logger.info(`[herdr] learned host key for ${hostId}: ${fingerprint}`);
      await saveHosts(next);
    }
  })();
});

streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  const settings = ev.settings as unknown as GlobalSettings;
  registry.setConfigs(Array.isArray(settings?.hosts) ? settings.hosts : []);
});

streamDeck.actions.registerAction(new AgentAction(ctx));
streamDeck.actions.registerAction(new SlotAction(ctx));
streamDeck.actions.registerAction(new AgentDialAction(ctx));

await streamDeck.connect();
registry.setConfigs((await loadGlobalSettings()).hosts ?? []);
logger.info("[herdr] plugin connected");
