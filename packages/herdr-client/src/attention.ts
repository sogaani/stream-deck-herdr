import type { AgentInfo, AgentStatus, HerdrState, TabInfo, WorkspaceInfo } from "./types.js";

const RANK: Record<AgentStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

/**
 * Status as the user perceives it: an idle agent whose completion has not been
 * acknowledged is shown as `done`.
 */
export function effectiveStatus(agent: Pick<AgentInfo, "agent_status" | "completion_seq">): AgentStatus {
  if (agent.agent_status === "idle" && typeof agent.completion_seq === "number") {
    return "done";
  }
  return agent.agent_status;
}

function paneNumber(paneId: string): number {
  const match = /p(\d+)$/.exec(paneId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function indexMap<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  items.forEach((item, index) => map.set(key(item), index));
  return map;
}

/**
 * Orders agents so the ones needing attention come first:
 * blocked (oldest first) → done → working → idle → unknown, then by
 * workspace, tab and pane order within each group.
 */
export function sortByAttention(
  agents: AgentInfo[],
  workspaces: WorkspaceInfo[] = [],
  tabs: TabInfo[] = [],
): AgentInfo[] {
  const workspaceOrder = indexMap(workspaces, (w) => w.workspace_id);
  const tabOrder = indexMap(tabs, (t) => t.tab_id);
  const orderOf = (map: Map<string, number>, id: string) => map.get(id) ?? Number.MAX_SAFE_INTEGER;

  return [...agents].sort((a, b) => {
    const statusA = effectiveStatus(a);
    const statusB = effectiveStatus(b);
    if (RANK[statusA] !== RANK[statusB]) return RANK[statusA] - RANK[statusB];
    if (statusA === "blocked") {
      const seqA = a.state_change_seq ?? Number.MAX_SAFE_INTEGER;
      const seqB = b.state_change_seq ?? Number.MAX_SAFE_INTEGER;
      if (seqA !== seqB) return seqA - seqB;
    }
    const wsDiff = orderOf(workspaceOrder, a.workspace_id) - orderOf(workspaceOrder, b.workspace_id);
    if (wsDiff !== 0) return wsDiff;
    const tabDiff = orderOf(tabOrder, a.tab_id) - orderOf(tabOrder, b.tab_id);
    if (tabDiff !== 0) return tabDiff;
    return paneNumber(a.pane_id) - paneNumber(b.pane_id);
  });
}

export function sortStateByAttention(state: HerdrState): AgentInfo[] {
  return sortByAttention(state.agents, state.workspaces, state.tabs);
}

/** Returns the 1-based `slot`-th agent of an attention-sorted list. */
export function slotAt(sorted: AgentInfo[], slot: number): AgentInfo | undefined {
  if (!Number.isInteger(slot) || slot < 1) return undefined;
  return sorted[slot - 1];
}

/** Counts agents per effective status. */
export function countByStatus(agents: AgentInfo[]): Record<AgentStatus, number> {
  const counts: Record<AgentStatus, number> = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0 };
  for (const agent of agents) counts[effectiveStatus(agent)] += 1;
  return counts;
}
