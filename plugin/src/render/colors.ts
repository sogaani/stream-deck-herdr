import type { AgentStatus } from "@stream-deck-herdr/herdr-client";

export const STATUS_COLORS: Record<AgentStatus, string> = {
  blocked: "#f38ba8",
  working: "#89b4fa",
  done: "#a6e3a1",
  idle: "#6c7086",
  unknown: "#45475a",
};

export const STATUS_LABELS: Record<AgentStatus, string> = {
  blocked: "BLOCKED",
  working: "WORKING",
  done: "DONE",
  idle: "IDLE",
  unknown: "UNKNOWN",
};

export const COLORS = {
  background: "#1e1e2e",
  surface: "#313244",
  text: "#cdd6f4",
  subtext: "#a6adc8",
  muted: "#585b70",
  offline: "#f9e2af",
};
