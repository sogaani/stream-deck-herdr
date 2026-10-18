import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import ssh2 from "ssh2";
import { pathToFileURL } from "node:url";
const bundle = await import(pathToFileURL(path.resolve(process.env.BUNDLE)).href);
const { SshTransport, requestOnce, AgentWatcher } = bundle;

// Fake Herdr: one request per connection.
const dir = mkdtempSync(path.join(os.tmpdir(), "bc-"));
const sock = path.join(dir, "herdr.sock");
net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    const req = JSON.parse(buf.slice(0, i));
    if (req.method === "events.subscribe") { c.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n"); return; }
    const result = req.method === "ping" ? { type: "pong" } : { type: "session_snapshot", snapshot: { agents: [{ agent: "claude", agent_status: "blocked", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "t", focused: false, revision: 1 }], workspaces: [], tabs: [], panes: [] } };
    c.write(JSON.stringify({ id: req.id, result }) + "\n"); c.end();
  });
}).listen(sock);

const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject(["password"])));
  client.on("ready", () => {
    client.on("session", (accept) => accept().on("exec", (a, r, info) => { const ch = a(); ch.write(JSON.stringify({ server: { socket: sock, running: true } })); ch.exit(0); ch.end(); }));
    client.on("openssh.streamlocal", (accept, reject, info) => { const ch = accept(); const s = net.connect(info.socketPath); s.pipe(ch).pipe(s); s.on("close", () => ch.end()); ch.on("close", () => s.destroy()); });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const t = new SshTransport({ host: "127.0.0.1", port, auth: { type: "password", username: "u", password: "pw" } }, { useSshConfig: false });
console.log("ping via bundled ssh2:", await requestOnce(t, "ping"));
const w = new AgentWatcher(t, { pollIntervalMs: 0 });
await new Promise((resolve, reject) => { w.on("status", (s) => { if (s.state === "online") resolve(); if (s.state === "offline") reject(new Error(s.error?.message)); }); w.start(); });
console.log("watcher online, agents:", w.state.agents.map((a) => `${a.pane_id}:${a.agent_status}`));
await w.stop(); server.close(); process.exit(0);
// Usage: npm run check-bundle -w plugin
// Bundles @stream-deck-herdr/herdr-client with the same rollup pipeline as the
// plugin and verifies that the bundled ssh2 can authenticate with a password
// and forward a Unix socket (catches bundling regressions such as a missing
// __dirname shim).
