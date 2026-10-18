import type { AgentInfo } from "@stream-deck-herdr/herdr-client";
import type { HostConnection, Logger } from "../hosts/HostConnection.js";
import { approveKeys, denyKeys, requireBlocked, type PressAction, type PressSettings } from "../settings.js";

export interface PressOutcome {
  ok: boolean;
  action: "approved" | "denied" | "focused" | "failed";
  message: string;
}

/**
 * Executes a configured press action against an agent. `approve` / `decline`
 * re-read the agent's state right before typing and, when `requireBlocked` is
 * on and the agent is not blocked, focus the pane instead of sending keys.
 */
export async function performPress(
  conn: HostConnection,
  agent: AgentInfo,
  action: PressAction,
  settings: PressSettings,
  logger: Logger,
): Promise<PressOutcome> {
  const target = agent.pane_id;
  try {
    if (action === "focus") {
      await conn.request("agent.focus", { target });
      return { ok: true, action: "focused", message: `focused ${target}` };
    }
    const fresh = await conn.request<{ agent?: AgentInfo }>("agent.get", { target });
    const status = fresh.agent?.agent_status ?? agent.agent_status;
    const mayType = status === "blocked" || !requireBlocked(settings);
    if (!mayType) {
      await conn.request("agent.focus", { target });
      return { ok: true, action: "focused", message: `focused ${target} (${status}, not blocked)` };
    }
    const keys = action === "approve" ? approveKeys(settings) : denyKeys(settings);
    await conn.request("agent.send_keys", { target, keys });
    logger.info(`[herdr] ${action} ${target} with ${keys.join(" ")}`);
    return { ok: true, action: action === "approve" ? "approved" : "denied", message: `sent ${keys.join(" ")} to ${target}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[herdr] ${action} on ${target} failed: ${message}`);
    return { ok: false, action: "failed", message };
  }
}
