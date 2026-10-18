/**
 * Live smoke test over SSH.
 *
 *   npx tsx scripts/ssh-smoke.ts <host> --user U (--password [PW] | --key PATH [--passphrase P] | --agent)
 *                                 [--port N] [--remote-session NAME] [--remote-socket PATH] [--watch]
 *
 * Without --watch it pings, prints the agent list and exits. With --watch it
 * keeps an AgentWatcher running and prints every change.
 */
import readline from "node:readline/promises";
import { AgentWatcher, SshTransport, effectiveStatus, requestOnce, sortStateByAttention, type SshAuth } from "../src/index.js";

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith("--"));
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
if (!host) {
  console.error("usage: ssh-smoke.ts <host> --user U (--password [PW] | --key PATH | --agent) [--port N] [--watch]");
  process.exit(2);
}

const username = flag("--user") ?? process.env.USER ?? "";
let auth: SshAuth;
if (has("--key")) {
  auth = { type: "key", username, identityFile: flag("--key")!, passphrase: flag("--passphrase") };
} else if (has("--agent")) {
  auth = { type: "agent", username };
} else {
  let password = flag("--password");
  if (!password || password.startsWith("--")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question(`password for ${username}@${host}: `);
    rl.close();
  }
  auth = { type: "password", username, password };
}

const transport = new SshTransport(
  {
    host,
    port: flag("--port") ? Number(flag("--port")) : undefined,
    auth,
    remoteSession: flag("--remote-session"),
    remoteSocketPath: flag("--remote-socket"),
  },
  { logger: console },
);
transport.on("hostkey", (fp) => console.log(`learned host key ${fp}`));
transport.on("close", (err) => console.log(`[ssh] closed: ${err?.message ?? ""}`));

const started = Date.now();
console.log("ping:", await requestOnce(transport, "ping"), `(${Date.now() - started}ms)`);

if (!has("--watch")) {
  const list = await requestOnce<{ agents: { pane_id: string; agent: string; agent_status: string }[] }>(transport, "agent.list");
  for (const a of list.agents) console.log(`  ${a.agent_status.padEnd(7)} ${a.pane_id.padEnd(7)} ${a.agent}`);
  await transport.dispose();
  process.exit(0);
}

const watcher = new AgentWatcher(transport, { logger: console });
watcher.on("status", (s) => console.log(`[status] ${s.state}${s.error ? ` ${s.error.message}` : ""}`));
watcher.on("agents", (state) => {
  console.log(`--- ${new Date().toISOString().slice(11, 23)} ${state.agents.length} agents`);
  for (const a of sortStateByAttention(state)) console.log(`  ${effectiveStatus(a).padEnd(7)} ${a.pane_id.padEnd(7)} ${a.agent.padEnd(8)} ${a.terminal_title_stripped ?? ""}`);
});
watcher.start();
process.on("SIGINT", () => void watcher.stop().then(() => process.exit(0)));
