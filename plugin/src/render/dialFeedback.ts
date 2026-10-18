import { effectiveStatus, type AgentInfo, type HerdrState } from "@stream-deck-herdr/herdr-client";
import { agentLabels } from "./agentView.js";
import { COLORS, STATUS_COLORS, STATUS_LABELS } from "./colors.js";

export interface DialFeedbackModel {
  agent: AgentInfo | null;
  state: Pick<HerdrState, "workspaces" | "tabs"> | null;
  index: number;
  total: number;
  hostLabel?: string;
  offlineMessage?: string;
}

/** Builds the `setFeedback` payload for `layouts/agent-dial.json`. */
export function dialFeedback(model: DialFeedbackModel): Record<string, unknown> {
  if (model.offlineMessage) {
    return {
      "state-bar": { background: COLORS.offline },
      title: { value: "Herdr offline", color: COLORS.text },
      subtitle: { value: model.offlineMessage },
      status: { value: "OFFLINE", color: COLORS.offline },
      position: { value: model.hostLabel ?? "" },
      indicator: { value: 0 },
    };
  }
  if (!model.agent || !model.state) {
    return {
      "state-bar": { background: COLORS.surface },
      title: { value: "No agents", color: COLORS.subtext },
      subtitle: { value: model.hostLabel ?? "" },
      status: { value: "", color: COLORS.subtext },
      position: { value: "0/0" },
      indicator: { value: 0 },
    };
  }
  const status = effectiveStatus(model.agent);
  const labels = agentLabels(model.agent, model.state);
  const color = STATUS_COLORS[status];
  return {
    "state-bar": { background: color },
    title: { value: labels.title, color: COLORS.text },
    subtitle: { value: labels.caption },
    status: { value: STATUS_LABELS[status], color },
    position: { value: `${model.index + 1}/${model.total}` },
    indicator: { value: model.total > 1 ? Math.round((model.index / (model.total - 1)) * 100) : 100, bar_fill_c: color },
  };
}
