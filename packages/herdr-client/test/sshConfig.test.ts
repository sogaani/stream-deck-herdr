import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSshConfigHost } from "../src/sshConfig.js";

describe("resolveSshConfigHost", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sshcfg-"));
  const file = path.join(dir, "config");
  writeFileSync(
    file,
    ["Host work", "  HostName 10.0.0.5", "  User bob", "  Port 2222", "  IdentityFile ~/.ssh/id_work", "", "Host *", "  ServerAliveInterval 30", ""].join("\n"),
  );

  it("expands a matching alias", async () => {
    const r = await resolveSshConfigHost("work", file);
    expect(r).toMatchObject({ hostname: "10.0.0.5", port: 2222, username: "bob", matched: true });
    expect(r.identityFiles[0]).toBe(path.join(os.homedir(), ".ssh", "id_work"));
  });

  it("passes unknown hosts through untouched", async () => {
    const r = await resolveSshConfigHost("203.0.113.9", file);
    expect(r).toMatchObject({ hostname: "203.0.113.9", port: null, username: null, matched: false });
  });

  it("never throws for a missing file", async () => {
    const r = await resolveSshConfigHost("x", path.join(dir, "missing"));
    expect(r.hostname).toBe("x");
    expect(r.matched).toBe(false);
  });
});
