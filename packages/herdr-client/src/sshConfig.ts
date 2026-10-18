import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import SSHConfig from "ssh-config";

export interface ResolvedSshHost {
  /** Hostname or IP to connect to. */
  hostname: string;
  port: number | null;
  username: string | null;
  identityFiles: string[];
  /** True when a `Host` block of ~/.ssh/config matched the alias. */
  matched: boolean;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolves `alias` against an OpenSSH client config (default `~/.ssh/config`).
 * Only HostName, User, Port and IdentityFile are honoured; ProxyJump and other
 * directives are ignored. Never throws: a missing or unreadable file yields the
 * alias itself.
 */
export async function resolveSshConfigHost(alias: string, configPath?: string): Promise<ResolvedSshHost> {
  const fallback: ResolvedSshHost = { hostname: alias, port: null, username: null, identityFiles: [], matched: false };
  let text: string;
  try {
    text = await readFile(configPath ?? path.join(os.homedir(), ".ssh", "config"), "utf8");
  } catch {
    return fallback;
  }
  try {
    const computed = SSHConfig.parse(text).compute(alias) as Record<string, string | string[] | undefined>;
    const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
    const hostname = str(computed.HostName);
    const port = str(computed.Port);
    const identity = computed.IdentityFile;
    const identityFiles = (Array.isArray(identity) ? identity : identity ? [identity] : []).map(expandHome);
    const matched = Object.keys(computed).some((k) => k !== "Host" && k !== "Match") && (hostname !== null || identityFiles.length > 0 || str(computed.User) !== null);
    return {
      hostname: hostname ?? alias,
      port: port ? Number(port) : null,
      username: str(computed.User),
      identityFiles,
      matched,
    };
  } catch {
    return fallback;
  }
}
