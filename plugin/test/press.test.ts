import { describe, expect, it, vi } from "vitest";
import { performPress } from "../src/actions/performPress.js";
import { pressActionFor } from "../src/settings.js";
import type { HostConnection } from "../src/hosts/HostConnection.js";
import type { AgentInfo } from "@stream-deck-herdr/herdr-client";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const agent = (agent_status: AgentInfo["agent_status"]): AgentInfo => ({
  agent: "claude",
  agent_status,
  pane_id: "w1:p1",
  tab_id: "w1:t1",
  workspace_id: "w1",
  terminal_id: "t",
  focused: false,
  revision: 1,
  state_change_seq: 1,
});

/** Fake host connection whose `agent.get` reports the given live status. */
function fakeConn(liveStatus: AgentInfo["agent_status"] | Error) {
  const request = vi.fn(async (method: string) => {
    if (liveStatus instanceof Error) throw liveStatus;
    if (method === "agent.get") return { agent: agent(liveStatus) };
    return {};
  });
  return { conn: { request } as unknown as HostConnection, request };
}

const methods = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map((c) => c[0]);

describe("pressActionFor", () => {
  it("defaults to approve for short and decline for long presses", () => {
    expect(pressActionFor({}, "short")).toBe("approve");
    expect(pressActionFor({}, "long")).toBe("decline");
  });

  it("honours configured actions and ignores unknown values", () => {
    expect(pressActionFor({ shortPress: "focus", longPress: "approve" }, "short")).toBe("focus");
    expect(pressActionFor({ shortPress: "focus", longPress: "approve" }, "long")).toBe("approve");
    expect(pressActionFor({ shortPress: "nope" as never }, "short")).toBe("approve");
    expect(pressActionFor({ longPress: "" as never }, "long")).toBe("decline");
  });
});

describe("performPress", () => {
  it("approves a blocked agent with the approve keys after re-reading its state", async () => {
    const { conn, request } = fakeConn("blocked");
    const outcome = await performPress(conn, agent("blocked"), "approve", {}, logger);
    expect(outcome).toMatchObject({ ok: true, action: "approved" });
    expect(methods(request)).toEqual(["agent.get", "agent.send_keys"]);
    expect(request.mock.calls[1]?.[1]).toEqual({ target: "w1:p1", keys: ["enter"] });
  });

  it("declines a blocked agent with the deny keys", async () => {
    const { conn, request } = fakeConn("blocked");
    const outcome = await performPress(conn, agent("blocked"), "decline", { denyKeys: "ctrl+c" }, logger);
    expect(outcome.action).toBe("denied");
    expect(request.mock.calls[1]?.[1]).toEqual({ target: "w1:p1", keys: ["ctrl+c"] });
  });

  it("focuses instead of typing when the agent is not blocked and safety is on", async () => {
    for (const action of ["approve", "decline"] as const) {
      const { conn, request } = fakeConn("idle");
      const outcome = await performPress(conn, agent("blocked"), action, {}, logger);
      expect(outcome).toMatchObject({ ok: true, action: "focused" });
      expect(methods(request)).toEqual(["agent.get", "agent.focus"]);
    }
  });

  it("types anyway when safety is off", async () => {
    const { conn, request } = fakeConn("working");
    const outcome = await performPress(conn, agent("working"), "approve", { requireBlocked: false }, logger);
    expect(outcome.action).toBe("approved");
    expect(methods(request)).toEqual(["agent.get", "agent.send_keys"]);
  });

  it("focus only calls agent.focus", async () => {
    const { conn, request } = fakeConn("blocked");
    const outcome = await performPress(conn, agent("blocked"), "focus", {}, logger);
    expect(outcome).toMatchObject({ ok: true, action: "focused" });
    expect(methods(request)).toEqual(["agent.focus"]);
  });

  it("reports failures", async () => {
    const { conn } = fakeConn(new Error("boom"));
    const outcome = await performPress(conn, agent("blocked"), "approve", {}, logger);
    expect(outcome).toMatchObject({ ok: false, action: "failed", message: "boom" });
  });
});
