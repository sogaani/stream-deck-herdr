import { effectiveStatus, type AgentInfo, type HerdrState } from "@stream-deck-herdr/herdr-client";

export interface AgentViewLabels {
  /** Primary text: terminal title, else workspace/tab. */
  title: string;
  /** Secondary text: agent kind plus workspace/tab when the title is a terminal title. */
  caption: string;
  workspace: string;
  tab: string;
}

export function agentLabels(agent: AgentInfo, state: Pick<HerdrState, "workspaces" | "tabs">): AgentViewLabels {
  const workspace = state.workspaces.find((w) => w.workspace_id === agent.workspace_id)?.label?.trim() || agent.workspace_id;
  const tab = state.tabs.find((t) => t.tab_id === agent.tab_id)?.label?.trim() || agent.tab_id.split(":")[1] || agent.tab_id;
  const kind = agent.display_agent?.trim() || agent.name?.trim() || agent.agent;
  const terminalTitle = agent.title?.trim() || agent.terminal_title_stripped?.trim() || "";
  const location = `${workspace}/${tab}`;
  if (terminalTitle && terminalTitle.toLowerCase() !== kind.toLowerCase()) {
    return { title: terminalTitle, caption: `${kind} · ${location}`, workspace, tab };
  }
  return { title: location, caption: kind, workspace, tab };
}

export function statusText(agent: AgentInfo): string {
  const status = effectiveStatus(agent);
  return agent.state_labels?.[status] ?? status;
}
