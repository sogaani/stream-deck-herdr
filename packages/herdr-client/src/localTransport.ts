import { EventEmitter } from "node:events";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Transport } from "./transport.js";

/** Connects to a local Herdr Unix socket or Windows named pipe. */
export class LocalTransport extends EventEmitter implements Transport {
  readonly label: string;

  constructor(readonly path: string, label?: string) {
    super();
    this.label = label ?? path;
  }

  connect(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.path);
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
    });
  }

  async dispose(): Promise<void> {
    // Nothing to tear down: each stream is independent.
  }
}
