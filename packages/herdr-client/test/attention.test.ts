import { describe, expect, it } from "vitest";
import { countByStatus, effectiveStatus, slotAt, sortByAttention } from "../src/attention.js";
import { makeAgent, makeTab, makeWorkspace } from "./fakeHerdr.js";

describe("attention ordering", () => {
  const workspaces = [makeWorkspace("w2", "second"), makeWorkspace("w1", "first")];
  const tabs = [makeTab("w2:t1"), makeTab("w1:t2"), makeTab("w1:t1")];

  it("treats idle agents with an unseen completion as done", () => {
    expect(effectiveStatus(makeAgent({ pane_id: "w1:p1", agent_status: "idle", completion_seq: 7 }))).toBe("done");
    expect(effectiveStatus(makeAgent({ pane_id: "w1:p1", agent_status: "idle" }))).toBe("idle");
    expect(effectiveStatus(makeAgent({ pane_id: "w1:p1", agent_status: "working", completion_seq: 7 }))).toBe("working");
  });

  it("puts blocked agents first, oldest block first, then done, working, idle, unknown", () => {
    const agents = [
      makeAgent({ pane_id: "w1:p1", agent_status: "idle" }),
      makeAgent({ pane_id: "w1:p2", agent_status: "blocked", state_change_seq: 50 }),
      makeAgent({ pane_id: "w2:p1", agent_status: "working" }),
      makeAgent({ pane_id: "w2:p2", agent_status: "blocked", state_change_seq: 10 }),
      makeAgent({ pane_id: "w1:p3", agent_status: "idle", completion_seq: 3 }),
      makeAgent({ pane_id: "w2:p3", agent_status: "unknown" }),
    ];
    const sorted = sortByAttention(agents, workspaces, tabs).map((a) => a.pane_id);
    expect(sorted).toEqual(["w2:p2", "w1:p2", "w1:p3", "w2:p1", "w1:p1", "w2:p3"]);
  });

  it("orders equal statuses by sidebar workspace, tab and pane order", () => {
    const agents = [
      makeAgent({ pane_id: "w1:p5", tab_id: "w1:t1", agent_status: "idle" }),
      makeAgent({ pane_id: "w1:p2", tab_id: "w1:t2", agent_status: "idle" }),
      makeAgent({ pane_id: "w1:p1", tab_id: "w1:t1", agent_status: "idle" }),
      makeAgent({ pane_id: "w2:p9", tab_id: "w2:t1", agent_status: "idle" }),
    ];
    expect(sortByAttention(agents, workspaces, tabs).map((a) => a.pane_id)).toEqual(["w2:p9", "w1:p2", "w1:p1", "w1:p5"]);
  });

  it("resolves slots 1-based and counts statuses", () => {
    const agents = [makeAgent({ pane_id: "w1:p1", agent_status: "blocked" }), makeAgent({ pane_id: "w1:p2" })];
    const sorted = sortByAttention(agents);
    expect(slotAt(sorted, 1)?.pane_id).toBe("w1:p1");
    expect(slotAt(sorted, 2)?.pane_id).toBe("w1:p2");
    expect(slotAt(sorted, 3)).toBeUndefined();
    expect(slotAt(sorted, 0)).toBeUndefined();
    expect(countByStatus(agents)).toEqual({ blocked: 1, idle: 1, done: 0, working: 0, unknown: 0 });
  });
});
