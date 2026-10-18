import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentWatcher } from "../src/watcher.js";
import type { HerdrState } from "../src/types.js";
import type { WatcherStatus } from "../src/watcher.js";
import { FakeHerdr, makeAgent, sleep, waitFor } from "./fakeHerdr.js";

describe("AgentWatcher", () => {
  let server: FakeHerdr;
  let watcher: AgentWatcher | null = null;

  beforeEach(async () => {
    server = new FakeHerdr();
    server.snapshot.agents = [makeAgent({ pane_id: "w1:p1", agent_status: "working" }), makeAgent({ pane_id: "w1:p2", agent_status: "idle" })];
    server.snapshot.panes = server.snapshot.agents.map((a) => ({ ...a }));
    await server.start();
  });
  afterEach(async () => {
    await watcher?.stop();
    watcher = null;
    await server.stop();
  });

  const start = (opts = {}) => {
    watcher = new AgentWatcher(server.transport(), { pollIntervalMs: 0, reconnectMinMs: 20, reconnectMaxMs: 50, refreshDebounceMs: 10, ...opts });
    const online = waitFor<WatcherStatus>(watcher, "status", (s) => s.state === "online");
    watcher.start();
    return online;
  };

  it("loads the snapshot and subscribes globally plus per agent pane", async () => {
    await start();
    expect(watcher!.state?.agents.map((a) => a.pane_id)).toEqual(["w1:p1", "w1:p2"]);
    await sleep(30);
    const subs = [...server.subscribers].map((s) => s.subscriptions);
    expect(subs.some((list) => list.some((s) => s.type === "pane.updated"))).toBe(true);
    const perPane = subs.find((list) => list.every((s) => s.type === "pane.agent_status_changed"));
    expect(perPane?.map((s) => (s as { pane_id: string }).pane_id).sort()).toEqual(["w1:p1", "w1:p2"]);
  });

  it("applies status change events immediately and reconciles afterwards", async () => {
    await start();
    await sleep(30);
    const changed = waitFor<HerdrState>(watcher!, "agents", (s) => s.agents.find((a) => a.pane_id === "w1:p1")?.agent_status === "blocked");
    server.snapshot.agents[0]!.agent_status = "blocked";
    server.snapshot.agents[0]!.state_change_seq = 99;
    server.broadcast("pane.agent_status_changed", { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" });
    await changed;
    const reconciled = await waitFor<HerdrState>(watcher!, "agents", (s) => s.agents.find((a) => a.pane_id === "w1:p1")?.state_change_seq === 99);
    expect(reconciled.agents[0]!.agent_status).toBe("blocked");
  });

  it("tracks the focused pane from pane.focused events", async () => {
    await start();
    await sleep(30);
    expect(watcher!.state?.focusedPaneId).toBeNull();
    server.broadcast("pane.focused", { pane_id: "w1:p2", workspace_id: "w1" });
    const focused = await waitFor<HerdrState>(watcher!, "agents", (s) => s.focusedPaneId === "w1:p2");
    expect(focused.agents.map((a) => a.focused)).toEqual([false, true]);
  });

  it("re-subscribes when a new agent pane appears", async () => {
    await start();
    await sleep(30);
    const newAgent = makeAgent({ pane_id: "w1:p3", agent_status: "working" });
    server.snapshot.agents.push(newAgent);
    server.snapshot.panes.push({ ...newAgent });
    server.broadcast("pane.agent_detected", { pane_id: "w1:p3", workspace_id: "w1" });
    await waitFor<HerdrState>(watcher!, "agents", (s) => s.agents.length === 3);
    await sleep(50);
    const perPane = [...server.subscribers].map((s) => s.subscriptions).find((list) => list.every((s) => s.type === "pane.agent_status_changed"));
    expect(perPane?.map((s) => (s as { pane_id: string }).pane_id).sort()).toEqual(["w1:p1", "w1:p2", "w1:p3"]);
    // Only one per-pane subscription remains (old one closed).
    expect([...server.subscribers].filter((s) => s.subscriptions.every((x) => x.type === "pane.agent_status_changed"))).toHaveLength(1);
  });

  it("updates agents from pane.updated payloads", async () => {
    await start();
    const updated = waitFor<HerdrState>(watcher!, "agents", (s) => s.agents[1]?.terminal_title_stripped === "Refactor auth");
    server.broadcast("pane.updated", { pane: { ...server.snapshot.agents[1], terminal_title_stripped: "Refactor auth" } });
    await updated;
  });

  it("goes offline and reconnects when the subscription connection drops", async () => {
    await start();
    await sleep(30);
    const offline = waitFor<WatcherStatus>(watcher!, "status", (s) => s.state === "offline");
    const backOnline = waitFor<WatcherStatus>(watcher!, "status", (s) => s.state === "online");
    [...server.subscribers][0]!.fail("events_lost", "too slow");
    const status = await offline;
    expect(status.error?.message).toContain("too slow");
    await backOnline;
    expect(watcher!.state?.agents).toHaveLength(2);
  });

  it("retries with backoff while the server is unreachable", async () => {
    await server.stop();
    watcher = new AgentWatcher(server.transport(), { pollIntervalMs: 0, reconnectMinMs: 10, reconnectMaxMs: 40, refreshDebounceMs: 10 });
    const statuses: WatcherStatus[] = [];
    watcher.on("status", (s) => statuses.push(s));
    watcher.start();
    await sleep(120);
    const offline = statuses.filter((s) => s.state === "offline");
    expect(offline.length).toBeGreaterThanOrEqual(2);
    expect(offline.map((s) => s.retryInMs)).toEqual(expect.arrayContaining([10, 20, 40]));
  });

  it("request() opens a fresh connection per call", async () => {
    await start();
    expect(await watcher!.request("ping")).toEqual({ type: "pong" });
    expect(await watcher!.request("ping")).toEqual({ type: "pong" });
    expect(server.requests.filter((r) => r.method === "ping")).toHaveLength(2);
  });
});
