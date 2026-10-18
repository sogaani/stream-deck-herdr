import { describe, expect, it } from "vitest";
import { agentLabels } from "../src/render/agentView.js";
import { dialFeedback } from "../src/render/dialFeedback.js";
import { renderKeyImage, renderKeySvg } from "../src/render/keyImage.js";
import { textWidth, truncate, wrapLines } from "../src/render/text.js";
import type { AgentInfo, HerdrState } from "@stream-deck-herdr/herdr-client";

const agent: AgentInfo = {
  agent: "claude",
  agent_status: "blocked",
  pane_id: "w1:p2",
  tab_id: "w1:t2",
  workspace_id: "w1",
  terminal_id: "t",
  focused: false,
  revision: 1,
  state_change_seq: 10,
  terminal_title_stripped: "rss-article-curation-feedback",
};

const state: HerdrState = {
  agents: [agent],
  workspaces: [{ workspace_id: "w1", label: "my-knowledge", focused: false }],
  tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "2", focused: false }],
  focusedPaneId: null,
  serverVersion: "0.9.3",
};

describe("text helpers", () => {
  it("counts CJK as double width", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("日本語")).toBe(6);
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("hello world", 6)).toBe("hello…");
    expect(truncate("short", 10)).toBe("short");
  });

  it("wraps on separators and caps the number of lines", () => {
    expect(wrapLines("rss-article-curation-feedback", 13, 2)).toEqual(["rss-article-", "curation-…"]);
    expect(wrapLines("my-knowledge/2", 13, 2)).toEqual(["my-knowledge/", "2"]);
    expect(wrapLines("short", 13, 2)).toEqual(["short"]);
  });
});

describe("agent labels", () => {
  it("prefers the terminal title and describes the location in the caption", () => {
    expect(agentLabels(agent, state)).toMatchObject({
      title: "rss-article-curation-feedback",
      caption: "claude · my-knowledge/2",
    });
  });

  it("falls back to workspace/tab when the title is just the agent name", () => {
    const plain = { ...agent, terminal_title_stripped: "Claude Code", display_agent: null };
    expect(agentLabels({ ...plain, agent: "claude code" }, state)).toMatchObject({ title: "my-knowledge/2", caption: "claude code" });
  });
});

describe("key image", () => {
  it("renders every state as valid-looking SVG with a data URI", () => {
    for (const status of ["blocked", "working", "done", "idle", "unknown"] as const) {
      const svg = renderKeySvg({ kind: "agent", status, title: "my-knowledge/2", caption: "claude", slot: 1 });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain(status.toUpperCase());
      expect(svg.endsWith("</svg>")).toBe(true);
    }
    expect(renderKeyImage({ kind: "empty", slot: 3 })).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("escapes XML special characters", () => {
    const svg = renderKeySvg({ kind: "agent", status: "idle", title: "a<b>&\"c\"", caption: "x" });
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;&amp;");
  });

  it("renders offline and unbound states", () => {
    expect(renderKeySvg({ kind: "offline", message: "connection refused", hostLabel: "workbox" })).toContain("OFFLINE");
    expect(renderKeySvg({ kind: "unbound" })).toContain("configure in");
  });
});

describe("dial feedback", () => {
  it("describes the selected agent and position", () => {
    const fb = dialFeedback({ agent, state, index: 1, total: 4 }) as Record<string, { value?: unknown }>;
    expect(fb.title?.value).toBe("rss-article-curation-feedback");
    expect(fb.status?.value).toBe("BLOCKED");
    expect(fb.position?.value).toBe("2/4");
    expect(fb.indicator?.value).toBe(33);
  });

  it("reports offline and empty lists", () => {
    expect((dialFeedback({ agent: null, state: null, index: 0, total: 0, offlineMessage: "x" }) as Record<string, { value?: unknown }>).status?.value).toBe("OFFLINE");
    expect((dialFeedback({ agent: null, state: null, index: 0, total: 0 }) as Record<string, { value?: unknown }>).title?.value).toBe("No agents");
  });
});
