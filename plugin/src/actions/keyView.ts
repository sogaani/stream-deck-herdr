import { effectiveStatus } from "@stream-deck-herdr/herdr-client";
import { agentLabels } from "../render/agentView.js";
import type { KeyImageModel } from "../render/keyImage.js";
import type { AgentRef, AgentStore } from "../store/AgentStore.js";

/** Builds the key image model for an agent reference, or an empty/offline model. */
export function agentKeyModel(store: AgentStore, hostId: string, ref: AgentRef | undefined, slot?: number): KeyImageModel {
  const showHost = store.hostCount() > 1;
  if (ref) {
    const labels = agentLabels(ref.agent, ref.state);
    return {
      kind: "agent",
      status: effectiveStatus(ref.agent),
      title: labels.title,
      caption: labels.caption,
      hostLabel: showHost ? ref.hostLabel : undefined,
      slot,
    };
  }
  const offline = store.offlineMessage(hostId);
  if (offline) {
    return { kind: "offline", message: offline, hostLabel: showHost || !hostId ? store.hostLabel(hostId) : undefined, slot };
  }
  return { kind: "empty", message: slot ? "no agent" : "agent gone", hostLabel: showHost ? store.hostLabel(hostId) : undefined, slot };
}
