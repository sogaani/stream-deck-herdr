import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import ssh2 from "ssh2";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { requestOnce } from "../src/socket.js";
import { HostKeyChangedError, SshTransport, fingerprintSha256 } from "../src/sshTransport.js";
import { AgentWatcher } from "../src/watcher.js";
import { FakeHerdr, makeAgent, waitFor } from "./fakeHerdr.js";
import type { WatcherStatus } from "../src/watcher.js";

const { Server, utils } = ssh2;

const PASSWORD = "s3cret";
const USER = "tester";

describe("SshTransport", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ssh2test-"));
  const hostKey = utils.generateKeyPairSync("ed25519");
  const clientKey = utils.generateKeyPairSync("ed25519");
  const clientKeyPath = path.join(dir, "id_test");
  writeFileSync(clientKeyPath, clientKey.private);
  const clientPub = utils.parseKey(clientKey.public) as ssh2.ParsedKey;
  const hostFingerprint = fingerprintSha256((utils.parseKey(hostKey.public) as ssh2.ParsedKey).getPublicSSH());

  let herdr: FakeHerdr;
  let sshServer: InstanceType<typeof Server>;
  let sshPort = 0;
  const execCalls: string[] = [];
  let herdrOnPath = true;

  beforeAll(async () => {
    herdr = new FakeHerdr();
    herdr.snapshot.agents = [makeAgent({ pane_id: "w1:p1", agent_status: "blocked", state_change_seq: 5 })];
    herdr.snapshot.panes = herdr.snapshot.agents.map((a) => ({ ...a }));
    await herdr.start();

    sshServer = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client
        .on("authentication", (ctx) => {
          if (ctx.username !== USER) return ctx.reject();
          switch (ctx.method) {
            case "password":
              return ctx.password === PASSWORD ? ctx.accept() : ctx.reject();
            case "publickey": {
              const ok =
                ctx.key.algo === clientPub.type &&
                timingSafeEqual(ctx.key.data, clientPub.getPublicSSH()) &&
                (!ctx.signature || clientPub.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true);
              return ok ? ctx.accept() : ctx.reject();
            }
            case "keyboard-interactive":
              return ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) =>
                answers[0] === PASSWORD ? ctx.accept() : ctx.reject(),
              );
            default:
              return ctx.reject(["password", "publickey", "keyboard-interactive"]);
          }
        })
        .on("ready", () => {
          client.on("session", (accept) => {
            const session = accept();
            session.on("exec", (acceptExec, _reject, info) => {
              execCalls.push(info.command);
              const channel = acceptExec();
              if (info.command.startsWith("herdr") && herdrOnPath) {
                channel.write(JSON.stringify({ server: { socket: herdr.socketPath, running: true } }));
                channel.exit(0);
              } else if (info.command.includes('printf %s "$HOME"')) {
                channel.write("/home/tester");
                channel.exit(0);
              } else {
                channel.stderr.write("command not found\n");
                channel.exit(127);
              }
              channel.end();
            });
          });
          client.on("openssh.streamlocal", (accept, reject, info) => {
            if (info.socketPath !== herdr.socketPath) return reject();
            const channel = accept();
            const socket = net.connect(herdr.socketPath);
            socket.on("error", () => channel.end());
            socket.pipe(channel).pipe(socket);
            socket.once("close", () => channel.end());
            channel.once("close", () => socket.destroy());
          });
        })
        .on("error", () => {});
    });
    await new Promise<void>((resolve) => sshServer.listen(0, "127.0.0.1", () => resolve()));
    sshPort = (sshServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => sshServer.close(() => resolve()));
    await herdr.stop();
  });

  afterEach(() => {
    execCalls.length = 0;
    herdrOnPath = true;
  });

  const base = { host: "127.0.0.1", port: () => sshPort };

  it("authenticates with a password and forwards to the remote herdr socket", async () => {
    const transport = new SshTransport({ host: base.host, port: sshPort, auth: { type: "password", username: USER, password: PASSWORD } }, { useSshConfig: false });
    const learned: string[] = [];
    transport.on("hostkey", (fp) => learned.push(fp));
    expect(await requestOnce(transport, "ping")).toEqual({ type: "pong" });
    expect(learned).toEqual([hostFingerprint]);
    expect(execCalls[0]).toBe("herdr status --json");
    // Second connection reuses the SSH session and cached socket path.
    expect(await requestOnce(transport, "ping")).toEqual({ type: "pong" });
    expect(execCalls).toHaveLength(1);
    await transport.dispose();
  });

  it("authenticates with a private key file", async () => {
    const transport = new SshTransport({ host: base.host, port: sshPort, auth: { type: "key", username: USER, identityFile: clientKeyPath } }, { useSshConfig: false });
    expect(await requestOnce(transport, "ping")).toEqual({ type: "pong" });
    await transport.dispose();
  });

  it("rejects a wrong password with an error", async () => {
    const transport = new SshTransport({ host: base.host, port: sshPort, auth: { type: "password", username: USER, password: "nope" } }, { useSshConfig: false });
    await expect(requestOnce(transport, "ping")).rejects.toThrow(/authentication/i);
    await transport.dispose();
  });

  it("refuses a changed host key", async () => {
    const transport = new SshTransport(
      { host: base.host, port: sshPort, auth: { type: "password", username: USER, password: PASSWORD }, knownHostKey: "SHA256:AAAA" },
      { useSshConfig: false },
    );
    await expect(requestOnce(transport, "ping")).rejects.toBeInstanceOf(HostKeyChangedError);
    await transport.dispose();
  });

  it("accepts a matching known host key", async () => {
    const transport = new SshTransport(
      { host: base.host, port: sshPort, auth: { type: "password", username: USER, password: PASSWORD }, knownHostKey: hostFingerprint },
      { useSshConfig: false },
    );
    expect(await requestOnce(transport, "ping")).toEqual({ type: "pong" });
    await transport.dispose();
  });

  it("falls back to the conventional socket path when herdr is not on the remote PATH", async () => {
    herdrOnPath = false;
    const transport = new SshTransport(
      { host: base.host, port: sshPort, auth: { type: "password", username: USER, password: PASSWORD }, remoteSession: "agents" },
      { useSshConfig: false },
    );
    // Forwarding to the guessed path is rejected by our test server, so we only check the resolution.
    await expect(requestOnce(transport, "ping")).rejects.toThrow();
    expect(execCalls.some((c) => c.includes('"$HOME"'))).toBe(true);
    await transport.dispose();
  });

  it("drives an AgentWatcher end to end over SSH", async () => {
    const transport = new SshTransport({ host: base.host, port: sshPort, auth: { type: "password", username: USER, password: PASSWORD } }, { useSshConfig: false });
    const watcher = new AgentWatcher(transport, { pollIntervalMs: 0, refreshDebounceMs: 10 });
    const online = waitFor<WatcherStatus>(watcher, "status", (s) => s.state === "online");
    watcher.start();
    await online;
    expect(watcher.state?.agents[0]?.agent_status).toBe("blocked");
    expect(await watcher.request("ping")).toEqual({ type: "pong" });
    await watcher.stop();
  });
});
