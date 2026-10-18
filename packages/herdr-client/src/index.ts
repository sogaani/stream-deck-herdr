export * from "./types.js";
export type { Transport } from "./transport.js";
export { LocalTransport } from "./localTransport.js";
export { SshTransport, HostKeyChangedError, type SshAuth, type SshTransportConfig, type SshTransportOptions } from "./sshTransport.js";
export { resolveSshConfigHost, type ResolvedSshHost } from "./sshConfig.js";
export { HerdrConnection, HerdrError, requestOnce } from "./socket.js";
export { AgentWatcher, type AgentWatcherOptions, type WatcherStatus, type WatcherConnectionState } from "./watcher.js";
export { sortByAttention, sortStateByAttention, slotAt, effectiveStatus, countByStatus } from "./attention.js";
export {
  resolveLocalSocket,
  defaultLocalSocketPath,
  herdrBinaryCandidates,
  type ResolveLocalOptions,
  type ResolvedLocal,
} from "./resolveLocal.js";
