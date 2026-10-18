import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostRegistry } from "../src/hosts/HostRegistry.js";
import { AgentStore } from "../src/store/AgentStore.js";
import { approveKeys, denyKeys, parseKeys, requireBlocked, validateHostConfig, type HostConfig } from "../src/settings.js";
import { FakeHerdr, makeAgent, makeTab, makeWorkspace, sleep } from "../../packages/herdr-client/test/fakeHerdr.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("settings helpers", () => {
  it("parses key lists with defaults", () => {
    expect(parseKeys(undefined, "enter")).toEqual(["enter"]);
    expect(parseKeys("down  enter", "enter")).toEqual(["down", "enter"]);
    expect(parseKeys("2, enter", "enter")).toEqual(["2", "enter"]);
    expect(approveKeys({})).toEqual(["enter"]);
    expect(denyKeys({ denyKeys: "ctrl+c" })).toEqual(["ctrl+c"]);
    expect(requireBlocked({})).toBe(true);
    expect(requireBlocked({ requireBlocked: false })).toBe(false);
  });

  it("validates host configs", () => {
    expect(validateHostConfig(undefined)).toMatch(/missing/);
    expect(validateHostConfig({ id: "a", label: "A", mode: "local" })).toBeNull();
    expect(validateHostConfig({ id: "a", label: "A", mode: "ssh", host: "", auth: { type: "agent", username: "u" } })).toMatch(/host name/);
    expect(validateHostConfig({ id: "a", label: "A", mode: "ssh", host: "h", auth: { type: "password", username: "u", password: "" } })).toMatch(/password/);
    expect(validateHostConfig({ id: "a", label: "A", mode: "ssh", host: "h", auth: { type: "key", username: "u", identityFile: "~/.ssh/id" } })).toBeNull();
  });
});

describe("HostRegistry + AgentStore", () => {
  let a: FakeHerdr;
  let b: FakeHerdr;
  let registry: HostRegistry;
  let store: AgentStore;

  beforeEach(async () => {
    a = new FakeHerdr();
    b = new FakeHerdr();
    a.snapshot.agents = [makeAgent({ pane_id: "w1:p1", agent_status: "idle" }), makeAgent({ pane_id: "w1:p2", agent_status: "blocked", state_change_seq: 20 })];
    a.snapshot.workspaces = [makeWorkspace("w1", "alpha")];
    a.snapshot.tabs = [makeTab("w1:t1")];
    b.snapshot.agents = [makeAgent({ pane_id: "w1:p1", agent_status: "blocked", state_change_seq: 5, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-b" } })];
    b.snapshot.workspaces = [makeWorkspace("w1", "beta")];
    for (const s of [a, b]) s.snapshot.panes = s.snapshot.agents.map((x) => ({ ...x }));
    await a.start();
    await b.start();
    registry = new HostRegistry(logger);
    store = new AgentStore(registry);
    registry.setConfigs(hosts());
  });

  afterEach(async () => {
    await registry.stopAll();
    await a.stop();
    await b.stop();
  });

  const hosts = (): HostConfig[] => [
    { id: "A", label: "Alpha", mode: "local", socketPath: a.socketPath },
    { id: "B", label: "Beta", mode: "local", socketPath: b.socketPath },
  ];

  const untilOnline = async (...ids: string[]) => {
    for (let i = 0; i < 100; i++) {
      if (ids.every((id) => store.host(id)?.state)) return;
      await sleep(20);
    }
    throw new Error("hosts did not come online");
  };

  it("starts only acquired hosts and merges agents across hosts in attention order", async () => {
    registry.acquire("key-1", "A");
    await untilOnline("A");
    expect(store.host("B")?.state).toBeNull();
    expect(store.sorted("A").map((r) => r.agent.pane_id)).toEqual(["w1:p2", "w1:p1"]);

    registry.acquire("key-2", "");
    await untilOnline("A", "B");
    const all = store.sorted("").map((r) => `${r.hostId}:${r.agent.pane_id}`);
    // Blocked agents first, oldest block (seq 5 on B) first, then the rest in host order.
    expect(all).toEqual(["B:w1:p1", "A:w1:p2", "A:w1:p1"]);
    expect(store.hostLabel("B")).toBe("Beta");
    expect(store.hostCount()).toBe(2);
  });

  it("finds agents by pane id or session id", async () => {
    registry.acquire("key-1", "B");
    await untilOnline("B");
    expect(store.find("B", "w1:p1")?.agent.pane_id).toBe("w1:p1");
    expect(store.find("B", "w9:p9", "sess-b")?.agent.pane_id).toBe("w1:p1");
    expect(store.find("B", "w9:p9", "nope")).toBeUndefined();
  });

  it("reports the focused agent per host", async () => {
    a.snapshot.focused_pane_id = "w1:p2";
    b.snapshot.focused_pane_id = "w1:p9"; // a non-agent pane
    registry.acquire("key-1", "");
    await untilOnline("A", "B");
    expect(store.focusedAgents("").map((r) => `${r.hostId}:${r.agent.pane_id}`)).toEqual(["A:w1:p2"]);
    expect(store.focusedAgents("B")).toEqual([]);
  });

  it("reports offline messages and restarts hosts whose config changed", async () => {
    registry.acquire("key-1", "A");
    await untilOnline("A");
    expect(store.offlineMessage("A")).toBeNull();
    expect(store.offlineMessage("missing")).toBe("host not found");

    registry.setConfigs([{ id: "A", label: "Alpha2", mode: "local", socketPath: a.socketPath }]);
    expect(store.host("A")?.state).toBeNull();
    await untilOnline("A");
    expect(store.hostLabel("A")).toBe("Alpha2");
    expect(store.host("B")).toBeUndefined();
  });

  it("emits change events coalesced per tick", async () => {
    let changes = 0;
    store.on("change", () => changes++);
    registry.acquire("key-1", "A");
    await untilOnline("A");
    const before = changes;
    a.snapshot.agents[0]!.agent_status = "working";
    a.broadcast("pane.agent_status_changed", { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" });
    await sleep(100);
    expect(changes).toBeGreaterThan(before);
    expect(store.sorted("A")[1]?.agent.agent_status).toBe("working");
  });
});
