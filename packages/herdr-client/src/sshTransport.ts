import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import ssh2 from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";
import { resolveSshConfigHost } from "./sshConfig.js";
import type { Transport } from "./transport.js";

const { Client } = ssh2;

export type SshAuth =
  | { type: "password"; username: string; password: string }
  | { type: "key"; username: string; identityFile: string; passphrase?: string }
  | { type: "agent"; username: string; agentPath?: string };

export interface SshTransportConfig {
  /** IP address, hostname, or `~/.ssh/config` alias. */
  host: string;
  port?: number;
  auth: SshAuth;
  /** Named Herdr session on the remote host. */
  remoteSession?: string;
  /** Absolute remote path of `herdr.sock`; skips discovery when set. */
  remoteSocketPath?: string;
  /** Previously learned host key fingerprint (`SHA256:…`). */
  knownHostKey?: string;
  label?: string;
}

export interface SshTransportOptions {
  /** Consult ~/.ssh/config for HostName/User/Port/IdentityFile (default true). */
  useSshConfig?: boolean;
  sshConfigPath?: string;
  readyTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  execTimeoutMs?: number;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export class HostKeyChangedError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`SSH host key changed: expected ${expected}, got ${actual}`);
    this.name = "HostKeyChangedError";
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function fingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function defaultAgentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";
  return undefined;
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Reaches a remote Herdr socket through SSH. One SSH session is kept open and
 * every `connect()` opens a `streamlocal@openssh.com` channel to the remote
 * `herdr.sock`, so nothing is bound locally and no daemon is needed remotely.
 */
export class SshTransport extends EventEmitter implements Transport {
  readonly label: string;
  private client: InstanceType<typeof Client> | null = null;
  private readyPromise: Promise<InstanceType<typeof Client>> | null = null;
  private remoteSocketPath: string | null;
  private disposed = false;
  private readonly opts: Required<Omit<SshTransportOptions, "sshConfigPath" | "logger">> & {
    sshConfigPath: string | undefined;
    logger: NonNullable<SshTransportOptions["logger"]>;
  };

  constructor(
    readonly config: SshTransportConfig,
    options: SshTransportOptions = {},
  ) {
    super();
    this.label = config.label ?? `${config.auth.username}@${config.host}`;
    this.remoteSocketPath = config.remoteSocketPath ?? null;
    this.opts = {
      useSshConfig: options.useSshConfig ?? true,
      sshConfigPath: options.sshConfigPath,
      readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? 15_000,
      keepaliveCountMax: options.keepaliveCountMax ?? 3,
      execTimeoutMs: options.execTimeoutMs ?? 15_000,
      logger: options.logger ?? noopLogger,
    };
  }

  /** Fingerprint of the remote host key seen on the current session. */
  hostKeyFingerprint: string | null = null;

  async connect(): Promise<Duplex> {
    const client = await this.ensureClient();
    const socketPath = await this.resolveRemoteSocketPath(client);
    return new Promise<Duplex>((resolve, reject) => {
      client.openssh_forwardOutStreamLocal(socketPath, (err, channel) => {
        if (err) {
          reject(this.describeChannelError(err, socketPath));
          return;
        }
        resolve(channel);
      });
    });
  }

  /** Runs a command on the remote host over the shared session. */
  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    const client = await this.ensureClient();
    return this.execWith(client, command, timeoutMs ?? this.opts.execTimeoutMs);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dropClient();
  }

  /** Forces the next `connect()` to open a fresh SSH session. */
  reset(): void {
    this.dropClient();
  }

  // ---------------------------------------------------------------------------

  private dropClient(): void {
    const client = this.client;
    this.client = null;
    this.readyPromise = null;
    if (client) {
      client.removeAllListeners();
      client.end();
    }
  }

  private ensureClient(): Promise<InstanceType<typeof Client>> {
    if (this.disposed) return Promise.reject(new Error(`ssh transport ${this.label} is disposed`));
    if (this.client) return Promise.resolve(this.client);
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.openClient().then(
      (client) => {
        this.client = client;
        this.readyPromise = null;
        return client;
      },
      (err) => {
        this.readyPromise = null;
        throw err;
      },
    );
    return this.readyPromise;
  }

  private async buildConnectConfig(): Promise<ConnectConfig> {
    const { config } = this;
    let hostname = config.host;
    let port = config.port ?? null;
    let username: string | null = config.auth.username || null;
    let identityFile = config.auth.type === "key" ? config.auth.identityFile : null;

    if (this.opts.useSshConfig) {
      const resolved = await resolveSshConfigHost(config.host, this.opts.sshConfigPath);
      if (resolved.matched) {
        hostname = resolved.hostname;
        port = port ?? resolved.port;
        username = username ?? resolved.username;
        if (config.auth.type === "key" && !identityFile) identityFile = resolved.identityFiles[0] ?? null;
      }
    }
    if (!username) throw new Error("SSH username is required");

    const connectConfig: ConnectConfig = {
      host: hostname,
      port: port ?? 22,
      username,
      readyTimeout: this.opts.readyTimeoutMs,
      keepaliveInterval: this.opts.keepaliveIntervalMs,
      keepaliveCountMax: this.opts.keepaliveCountMax,
      tryKeyboard: config.auth.type === "password",
      hostVerifier: (key: Buffer) => this.verifyHostKey(key),
    };

    switch (config.auth.type) {
      case "password":
        connectConfig.password = config.auth.password;
        break;
      case "key": {
        if (!identityFile) throw new Error("identityFile is required for key authentication");
        connectConfig.privateKey = await readFile(identityFile);
        if (config.auth.passphrase) connectConfig.passphrase = config.auth.passphrase;
        break;
      }
      case "agent": {
        const agentPath = config.auth.agentPath ?? defaultAgentPath();
        if (!agentPath) throw new Error("no ssh-agent found (SSH_AUTH_SOCK is not set)");
        connectConfig.agent = agentPath;
        break;
      }
    }
    return connectConfig;
  }

  private verifyHostKey(key: Buffer): boolean {
    const fingerprint = fingerprintSha256(key);
    this.hostKeyFingerprint = fingerprint;
    const known = this.config.knownHostKey;
    if (known && known !== fingerprint) {
      this.pendingHostKeyError = new HostKeyChangedError(known, fingerprint);
      return false;
    }
    if (!known) this.emit("hostkey", fingerprint);
    return true;
  }

  private pendingHostKeyError: HostKeyChangedError | null = null;

  private async openClient(): Promise<InstanceType<typeof Client>> {
    const connectConfig = await this.buildConnectConfig();
    this.pendingHostKeyError = null;
    const client = new Client();
    const { config, opts } = this;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        client.removeAllListeners();
        client.end();
        reject(this.pendingHostKeyError ?? err);
      };

      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        const password = config.auth.type === "password" ? config.auth.password : "";
        finish(prompts.map(() => password));
      });
      client.once("error", fail);
      client.once("ready", () => {
        settled = true;
        client.removeListener("error", fail);
        client.on("error", (err: Error) => this.onClientGone(client, err));
        client.once("close", () => this.onClientGone(client, new Error("SSH connection closed")));
        client.once("end", () => this.onClientGone(client, new Error("SSH connection ended")));
        opts.logger.info(`[herdr] ssh ${this.label}: connected`);
        resolve(client);
      });
      try {
        client.connect(connectConfig);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onClientGone(client: InstanceType<typeof Client>, err: Error): void {
    if (this.client !== client) return;
    this.client = null;
    this.readyPromise = null;
    client.removeAllListeners();
    this.opts.logger.warn(`[herdr] ssh ${this.label}: ${err.message}`);
    this.emit("close", err);
  }

  private execWith(client: InstanceType<typeof Client>, command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, channel: ClientChannel) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          channel.close();
          reject(new Error(`remote command timed out: ${command}`));
        }, timeoutMs);
        channel.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        channel.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        channel.once("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        channel.once("error", (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    });
  }

  private async resolveRemoteSocketPath(client: InstanceType<typeof Client>): Promise<string> {
    if (this.remoteSocketPath) return this.remoteSocketPath;
    const sessionArgs = this.config.remoteSession ? ` --session ${shellQuote(this.config.remoteSession)}` : "";
    const statusArgs = `${sessionArgs} status --json`;

    // 1. herdr on the non-interactive PATH (Linux/macOS/Windows remotes).
    // 2. Common install locations through a login shell (Linux/macOS remotes).
    const attempts = [
      `herdr${statusArgs}`,
      `sh -lc 'for p in herdr /opt/homebrew/bin/herdr /usr/local/bin/herdr "$HOME/.local/bin/herdr" "$HOME/.nix-profile/bin/herdr"; do if command -v "$p" >/dev/null 2>&1; then exec "$p"${statusArgs}; fi; done; exit 127'`,
    ];
    const errors: string[] = [];
    for (const command of attempts) {
      try {
        const result = await this.execWith(client, command, this.opts.execTimeoutMs);
        const start = result.stdout.indexOf("{");
        if (start >= 0) {
          const status = JSON.parse(result.stdout.slice(start)) as { server?: { socket?: string; running?: boolean } };
          const socket = status.server?.socket;
          if (socket) {
            if (status.server?.running === false) {
              throw new Error(`Herdr server is not running on ${this.label}`);
            }
            this.remoteSocketPath = socket;
            return socket;
          }
        }
        errors.push(`${command.split(" ")[0]}: exit ${result.code}${result.stderr ? ` ${result.stderr.trim().slice(0, 200)}` : ""}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Herdr server is not running")) throw err;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    // 3. Conventional path under the remote home directory.
    try {
      const home = (await this.execWith(client, `sh -c 'printf %s "$HOME"'`, this.opts.execTimeoutMs)).stdout.trim();
      if (home.startsWith("/")) {
        const socket = this.config.remoteSession
          ? `${home}/.config/herdr/sessions/${this.config.remoteSession}/herdr.sock`
          : `${home}/.config/herdr/herdr.sock`;
        this.opts.logger.warn(`[herdr] ssh ${this.label}: herdr CLI not found remotely, assuming ${socket}`);
        this.remoteSocketPath = socket;
        return socket;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    throw new Error(`cannot locate herdr.sock on ${this.label}: ${errors.join("; ")}`);
  }

  private describeChannelError(err: Error, socketPath: string): Error {
    const message = err.message.toLowerCase();
    if (message.includes("administratively prohibited")) {
      return new Error(`SSH server refused Unix socket forwarding (AllowStreamLocalForwarding?) for ${socketPath}`);
    }
    if (message.includes("connect failed") || message.includes("no such file")) {
      // The remembered path may be stale (e.g. Herdr restarted with another session).
      this.remoteSocketPath = this.config.remoteSocketPath ?? null;
      return new Error(`Herdr socket ${socketPath} is not accepting connections on ${this.label}: ${err.message}`);
    }
    return err;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
