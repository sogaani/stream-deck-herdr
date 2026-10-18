import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { herdrBinaryCandidates } from "@stream-deck-herdr/herdr-client";
import { HostConnection } from "../hosts/HostConnection.js";
import { agentLabels } from "../render/agentView.js";
import { ALL_HOSTS, validateHostConfig, type HostConfig } from "../settings.js";
import type { PluginContext } from "./context.js";

const execFileAsync = promisify(execFile);

export interface InspectorMessage {
  event: string;
  [key: string]: unknown;
}

export type Reply = (payload: Record<string, unknown>) => Promise<void> | void;

interface SavedMachine {
  id?: string;
  label?: string;
  target?: string;
  ssh_target?: string;
  remote_session?: string | null;
  session?: string | null;
  enabled?: boolean;
}

/** Reads `herdr machine list --json` on this machine and proposes SSH host configs. */
async function importHerdrMachines(): Promise<Partial<HostConfig>[]> {
  let lastError: unknown;
  for (const binary of herdrBinaryCandidates()) {
    try {
      const { stdout } = await execFileAsync(binary, ["machine", "list", "--json"], { timeout: 5_000, windowsHide: true });
      const start = stdout.indexOf("[");
      const machines = JSON.parse(stdout.slice(start)) as SavedMachine[];
      return machines
        .filter((m) => m.enabled !== false)
        .map((m) => {
          const target = m.ssh_target ?? m.target ?? "";
          const match = /^(?:ssh:\/\/)?(?:([^@]+)@)?([^:/]+)(?::(\d+))?/.exec(target);
          return {
            id: `herdr-${m.id ?? target}`,
            label: m.label ?? target,
            mode: "ssh" as const,
            host: match?.[2] ?? target,
            port: match?.[3] ? Number(match[3]) : undefined,
            auth: { type: "agent" as const, username: match?.[1] ?? "" },
            remoteSession: m.remote_session ?? m.session ?? undefined,
          };
        });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`herdr machine list failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function agentItems(ctx: PluginContext, hostId: string): { label: string; value: string }[] {
  if (!hostId) return [];
  const seen = new Map<string, number>();
  return ctx.store.sorted(hostId).map(({ agent, state }) => {
    const labels = agentLabels(agent, state);
    let label = `${labels.title} · ${labels.caption}`;
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    if (count > 1) label = `${label} (${agent.pane_id})`;
    return { label: `${label} [${agent.agent_status}]`, value: agent.pane_id };
  });
}

/**
 * Handles messages from the property inspector shared by every action.
 * Returns true when the message was recognised.
 */
export async function handleInspectorMessage(
  ctx: PluginContext,
  message: InspectorMessage,
  reply: Reply,
  options: { allowAllHosts: boolean; currentHostId?: string },
): Promise<boolean> {
  switch (message.event) {
    case "getHosts": {
      const items = ctx.registry.hosts().map((h) => ({ label: h.label, value: h.id }));
      if (options.allowAllHosts) items.unshift({ label: "All hosts", value: ALL_HOSTS });
      await reply({ event: "getHosts", items, hosts: ctx.registry.hosts() });
      return true;
    }
    case "getAgents": {
      const hostId = typeof message.hostId === "string" ? message.hostId : (options.currentHostId ?? "");
      await reply({ event: "getAgents", items: agentItems(ctx, hostId) });
      return true;
    }
    case "saveHosts": {
      const hosts = Array.isArray(message.hosts) ? (message.hosts as HostConfig[]) : [];
      for (const host of hosts) {
        const error = validateHostConfig(host);
        if (error) {
          await reply({ event: "saveHosts", ok: false, error: `${host?.label ?? host?.id ?? "host"}: ${error}` });
          return true;
        }
      }
      await ctx.saveHosts(hosts);
      await reply({ event: "saveHosts", ok: true, hosts });
      return true;
    }
    case "testHost": {
      const host = message.host as HostConfig | undefined;
      const error = validateHostConfig(host);
      if (error || !host) {
        await reply({ event: "testHost", ok: false, message: error ?? "invalid host" });
        return true;
      }
      const result = await HostConnection.test(host, ctx.logger);
      await reply({ event: "testHost", ...result, hostId: host.id });
      return true;
    }
    case "resetHostKey": {
      const hostId = String(message.hostId ?? "");
      const hosts = ctx.registry
        .hosts()
        .map((h) => (h.id === hostId && h.mode === "ssh" ? { ...h, knownHostKey: undefined } : h));
      await ctx.saveHosts(hosts);
      await reply({ event: "resetHostKey", ok: true, hosts });
      return true;
    }
    case "importMachines": {
      try {
        const hosts = await importHerdrMachines();
        await reply({ event: "importMachines", ok: true, hosts });
      } catch (err) {
        await reply({ event: "importMachines", ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "getStatus": {
      const hosts = ctx.registry.hosts().map((h) => {
        const view = ctx.store.host(h.id);
        return {
          hostId: h.id,
          label: h.label,
          state: view?.status.state ?? "stopped",
          error: view?.status.error ?? null,
          agents: view?.state?.agents.length ?? 0,
        };
      });
      await reply({ event: "getStatus", hosts });
      return true;
    }
    default:
      return false;
  }
}
