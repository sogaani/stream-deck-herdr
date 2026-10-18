import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolveLocalOptions {
  /** Named Herdr session; omit for the default session. */
  session?: string;
  /** Explicit path to the `herdr` executable. */
  herdrBinary?: string;
  /** Explicit socket path; skips discovery when set. */
  socketPath?: string;
  timeoutMs?: number;
}

export interface ResolvedLocal {
  socketPath: string;
  /** How the path was found. */
  source: "explicit" | "herdr-status" | "default-path";
  herdrBinary: string | null;
  serverRunning: boolean | null;
}

/** Candidate locations of the `herdr` executable for GUI-launched processes with a minimal PATH. */
export function herdrBinaryCandidates(explicit?: string): string[] {
  const home = os.homedir();
  const candidates = explicit ? [explicit] : [];
  if (process.platform === "win32") {
    candidates.push("herdr.exe", "herdr");
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(path.join(localAppData, "Programs", "herdr", "herdr.exe"));
  } else {
    candidates.push(
      "herdr",
      "/opt/homebrew/bin/herdr",
      "/usr/local/bin/herdr",
      path.join(home, ".local", "bin", "herdr"),
      path.join(home, ".nix-profile", "bin", "herdr"),
    );
  }
  return [...new Set(candidates)];
}

/** Default socket path used by Herdr on Unix-like systems. */
export function defaultLocalSocketPath(session?: string): string {
  const configDir = process.env.HERDR_CONFIG_PATH
    ? path.dirname(process.env.HERDR_CONFIG_PATH)
    : path.join(os.homedir(), ".config", "herdr");
  return session ? path.join(configDir, "sessions", session, "herdr.sock") : path.join(configDir, "herdr.sock");
}

interface HerdrStatusJson {
  server?: { socket?: string; running?: boolean; status?: string };
}

async function runStatus(binary: string, session: string | undefined, timeoutMs: number): Promise<HerdrStatusJson> {
  const args = session ? ["--session", session, "status", "--json"] : ["status", "--json"];
  const { stdout } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    windowsHide: true,
  });
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("herdr status returned no JSON");
  return JSON.parse(stdout.slice(start)) as HerdrStatusJson;
}

/**
 * Finds the local Herdr API socket. Prefers `herdr status --json` (which also
 * works for Windows named pipes), falling back to the conventional path.
 */
export async function resolveLocalSocket(options: ResolveLocalOptions = {}): Promise<ResolvedLocal> {
  if (options.socketPath) {
    return { socketPath: options.socketPath, source: "explicit", herdrBinary: null, serverRunning: null };
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  let lastError: unknown = null;
  for (const binary of herdrBinaryCandidates(options.herdrBinary)) {
    if (path.isAbsolute(binary) && !existsSync(binary)) continue;
    try {
      const status = await runStatus(binary, options.session, timeoutMs);
      const socketPath = status.server?.socket;
      if (socketPath) {
        return {
          socketPath,
          source: "herdr-status",
          herdrBinary: binary,
          serverRunning: status.server?.running ?? status.server?.status === "running",
        };
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (process.platform === "win32") {
    const reason = lastError instanceof Error ? lastError.message : "herdr executable not found";
    throw new Error(`cannot determine the Herdr named pipe (${reason}); set the socket path explicitly`);
  }
  return {
    socketPath: defaultLocalSocketPath(options.session),
    source: "default-path",
    herdrBinary: null,
    serverRunning: null,
  };
}
