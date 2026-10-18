/** Semantic agent lifecycle state reported by Herdr. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentSessionInfo {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}

export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

/** A pane as returned by `pane.*` methods and `session.snapshot`. */
export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  revision: number;
  agent?: string | null;
  agent_session?: AgentSessionInfo | null;
  display_agent?: string | null;
  label?: string | null;
  title?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  scroll?: PaneScrollInfo | null;
  restore_error?: string | null;
  state_change_seq?: number;
  completion_seq?: number;
}

/** An agent as returned by `agent.list` / `agent.get` / `session.snapshot`. */
export interface AgentInfo extends PaneInfo {
  agent: string;
  /** Unique live agent name assigned with `agent rename`, when any. */
  name?: string | null;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label?: string | null;
  number?: number;
  focused: boolean;
  agent_status?: AgentStatus;
  active_tab_id?: string | null;
  tab_count?: number;
  pane_count?: number;
  tokens?: Record<string, string>;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label?: string | null;
  number?: number;
  focused: boolean;
  agent_status?: AgentStatus;
  pane_count?: number;
}

export interface SessionSnapshot {
  version?: string;
  protocol?: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  layouts?: unknown[];
}

/** Subscription entries accepted by `events.subscribe`. */
export type Subscription =
  | { type: "workspace.created" | "workspace.updated" | "workspace.metadata_updated" | "workspace.renamed" | "workspace.moved" | "workspace.reordered" | "workspace.closed" | "workspace.focused" }
  | { type: "worktree.created" | "worktree.opened" | "worktree.removed" }
  | { type: "tab.created" | "tab.closed" | "tab.focused" | "tab.renamed" | "tab.moved" }
  | { type: "pane.created" | "pane.closed" | "pane.updated" | "pane.focused" | "pane.moved" | "pane.exited" | "pane.agent_detected" }
  | { type: "pane.agent_status_changed"; pane_id: string; agent_status?: AgentStatus | null }
  | { type: "pane.scroll_changed"; pane_id: string }
  | { type: "layout.updated" };

/** A pushed event line on a subscription connection. */
export interface PushedEvent<T = Record<string, unknown>> {
  /** Event name in underscore form, e.g. `pane_agent_status_changed`. */
  event: string;
  data: T & { type?: string };
}

export interface PaneAgentStatusChangedData {
  pane_id: string;
  workspace_id: string;
  agent_status: AgentStatus;
  agent?: string | null;
  display_agent?: string | null;
  title?: string | null;
  state_labels?: Record<string, string>;
}

export interface HerdrErrorBody {
  code: string;
  message: string;
}

/** Combined view of a Herdr session kept by {@link AgentWatcher}. */
export interface HerdrState {
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  focusedPaneId: string | null;
  serverVersion: string | null;
}
