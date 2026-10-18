import { describe, expect, it } from "vitest";
import { cursorIndex, keyOf, newCursor, rotateCursor, syncCursorToFocus } from "../src/actions/dialCursor.js";
import type { AgentRef } from "../src/store/AgentStore.js";
import type { AgentInfo, HerdrState } from "@stream-deck-herdr/herdr-client";

const state: HerdrState = { agents: [], workspaces: [], tabs: [], focusedPaneId: null, serverVersion: null };
const ref = (hostId: string, pane_id: string): AgentRef => ({
  hostId,
  hostLabel: hostId,
  state,
  agent: { agent: "claude", agent_status: "idle", pane_id, tab_id: "t", workspace_id: "w", terminal_id: "x", focused: false, revision: 1 } as AgentInfo,
});

const a1 = ref("A", "w1:p1");
const a2 = ref("A", "w1:p2");
const b1 = ref("B", "w1:p1");
const refs = [a1, a2, b1];

describe("dial cursor", () => {
  it("starts on the focused agent, or the first agent when nothing is focused", () => {
    const cursor = newCursor();
    syncCursorToFocus(cursor, refs, [a2], 1000);
    expect(cursorIndex(cursor, refs)).toBe(1);
    const idle = newCursor();
    syncCursorToFocus(idle, refs, [], 1000);
    expect(idle.selected).toBe(keyOf(a1));
  });

  it("follows focus changes in Herdr, picking the host whose focus moved", () => {
    const cursor = newCursor();
    syncCursorToFocus(cursor, refs, [a1, b1], 1000);
    expect(cursor.selected).toBe(keyOf(a1));
    syncCursorToFocus(cursor, refs, [a1, b1], 1001); // nothing changed
    expect(cursor.selected).toBe(keyOf(a1));
    syncCursorToFocus(cursor, refs, [a2, b1], 1002); // host A moved to p2
    expect(cursor.selected).toBe(keyOf(a2));
    syncCursorToFocus(cursor, refs, [a2], 1003); // host B focused a shell pane: keep selection
    expect(cursor.selected).toBe(keyOf(a2));
  });

  it("rotates within bounds and holds against stale focus events for a while", () => {
    const cursor = newCursor();
    syncCursorToFocus(cursor, refs, [a1], 1000);
    expect(rotateCursor(cursor, refs, 5, 1500, 1000)).toBe(b1);
    expect(rotateCursor(cursor, refs, -1, 1500, 1000)).toBe(a2);
    syncCursorToFocus(cursor, refs, [b1], 1500); // Herdr still reports the old target
    expect(cursor.selected).toBe(keyOf(a2));
    syncCursorToFocus(cursor, refs, [b1], 2600); // hold expired: no new focus, keep
    expect(cursor.selected).toBe(keyOf(a2));
    syncCursorToFocus(cursor, refs, [a1], 2700); // a real change after the hold wins
    expect(cursor.selected).toBe(keyOf(a1));
    expect(rotateCursor(cursor, [], 1, 1500, 2800)).toBeNull();
  });
});
