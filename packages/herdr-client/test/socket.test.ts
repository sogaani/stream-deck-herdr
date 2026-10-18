import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrConnection, HerdrError, requestOnce } from "../src/socket.js";
import { FakeHerdr, waitFor } from "./fakeHerdr.js";

describe("HerdrConnection", () => {
  let server: FakeHerdr;
  beforeEach(async () => {
    server = new FakeHerdr();
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("answers a one-shot request and tolerates the server closing afterwards", async () => {
    const result = await requestOnce<{ type: string }>(server.transport(), "ping");
    expect(result).toEqual({ type: "pong" });
    expect(server.requests.map((r) => r.method)).toEqual(["ping"]);
  });

  it("maps error responses to HerdrError", async () => {
    await expect(requestOnce(server.transport(), "nope")).rejects.toMatchObject({
      name: "HerdrError",
      code: "unknown_method",
    });
  });

  it("times out when no response arrives", async () => {
    server.hang.add("slow");
    const conn = await HerdrConnection.open(server.transport());
    await expect(conn.request("slow", {}, 50)).rejects.toMatchObject({ name: "HerdrError", code: "timeout" });
    conn.close();
  });

  it("delivers pushed events and reports events_lost as a close error", async () => {
    server.snapshot.panes = [{ pane_id: "w1:p1", terminal_id: "t", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle", revision: 1 }];
    const conn = await HerdrConnection.open(server.transport());
    const events: unknown[] = [];
    conn.on("event", (e) => events.push(e));
    await conn.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]);
    server.broadcast("pane.agent_status_changed", { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" });
    await waitFor(conn, "event");
    expect(events).toHaveLength(1);
    expect((events[0] as { event: string }).event).toBe("pane_agent_status_changed");

    const closed = waitFor<Error | undefined>(conn, "close");
    [...server.subscribers][0]!.fail("events_lost", "subscriber fell behind");
    const err = await closed;
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("events_lost");
    expect(conn.isClosed).toBe(true);
  });

  it("rejects subscriptions referencing unknown panes", async () => {
    const conn = await HerdrConnection.open(server.transport());
    await expect(conn.subscribe([{ type: "pane.agent_status_changed", pane_id: "w9:p9" }])).rejects.toMatchObject({ code: "not_found" });
  });
});
