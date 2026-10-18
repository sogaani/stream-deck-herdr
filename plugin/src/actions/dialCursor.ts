import type { AgentRef } from "../store/AgentStore.js";

export const keyOf = (ref: AgentRef) => `${ref.hostId}|${ref.agent.pane_id}`;

/** Selection state of one dial: follows Herdr's focused pane unless the user just rotated. */
export interface DialCursor {
  /** `${hostId}|${paneId}` of the highlighted agent. */
  selected: string | null;
  /** Focused agent keys seen on the last sync, to detect which host's focus moved. */
  knownFocus: Set<string>;
  /** Until this timestamp, focus events do not override a manual rotation. */
  manualUntil: number;
}

export function newCursor(): DialCursor {
  return { selected: null, knownFocus: new Set(), manualUntil: 0 };
}

/** Index of the selected agent in `refs`, or 0 when it is gone. */
export function cursorIndex(cursor: DialCursor, refs: AgentRef[]): number {
  if (!cursor.selected) return 0;
  const index = refs.findIndex((r) => keyOf(r) === cursor.selected);
  return index >= 0 ? index : 0;
}

/**
 * Re-aligns the cursor with Herdr's focus. With several hosts each one has its
 * own focused pane, so the cursor jumps to whichever focus changed most recently.
 */
export function syncCursorToFocus(cursor: DialCursor, refs: AgentRef[], focused: AgentRef[], now = Date.now()): void {
  const focusedKeys = focused.map(keyOf);
  const newlyFocused = focusedKeys.find((k) => !cursor.knownFocus.has(k));
  cursor.knownFocus = new Set(focusedKeys);
  if (now < cursor.manualUntil) return;
  if (newlyFocused) cursor.selected = newlyFocused;
  else if (cursor.selected === null) cursor.selected = focusedKeys[0] ?? (refs[0] ? keyOf(refs[0]) : null);
}

/** Moves the cursor by `ticks` and returns the newly selected agent (null when the list is empty). */
export function rotateCursor(cursor: DialCursor, refs: AgentRef[], ticks: number, holdMs: number, now = Date.now()): AgentRef | null {
  if (refs.length === 0) return null;
  const next = Math.min(refs.length - 1, Math.max(0, cursorIndex(cursor, refs) + ticks));
  const ref = refs[next]!;
  cursor.selected = keyOf(ref);
  cursor.manualUntil = now + holdMs;
  return ref;
}
