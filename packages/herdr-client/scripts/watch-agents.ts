/**
 * Live smoke test: prints the agents of a local Herdr session and every change.
 *
 *   npx tsx scripts/watch-agents.ts [--session NAME] [--socket PATH]
 */
import { AgentWatcher, LocalTransport, effectiveStatus, resolveLocalSocket, sortStateByAttention } from "../src/index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const resolved = await resolveLocalSocket({ session: flag("--session"), socketPath: flag("--socket") });
console.log(`socket: ${resolved.socketPath} (${resolved.source})`);

const watcher = new AgentWatcher(new LocalTransport(resolved.socketPath, "local"), {
  logger: console,
  pollIntervalMs: Number(flag("--poll") ?? 30_000),
});

watcher.on("status", (status) => console.log(`[status] ${status.state}${status.error ? ` ${status.error.message}` : ""}`));
watcher.on("agents", (state) => {
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`--- ${stamp} ${state.agents.length} agents (server ${state.serverVersion ?? "?"})`);
  for (const a of sortStateByAttention(state)) {
    const ws = state.workspaces.find((w) => w.workspace_id === a.workspace_id)?.label ?? a.workspace_id;
    const tab = state.tabs.find((t) => t.tab_id === a.tab_id)?.label ?? a.tab_id;
    console.log(
      `  ${effectiveStatus(a).padEnd(7)} ${a.pane_id.padEnd(7)} ${a.agent.padEnd(8)} ${ws}/${tab}  ${a.terminal_title_stripped ?? ""}  seq=${a.state_change_seq ?? "-"} done=${a.completion_seq ?? "-"}`,
    );
  }
});

watcher.start();
process.on("SIGINT", () => void watcher.stop().then(() => process.exit(0)));
