import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { LocalTransport, resolveLocalSocket, type ResolveLocalOptions, type Transport } from "@stream-deck-herdr/herdr-client";

/**
 * Local transport that discovers the socket path lazily (via `herdr status`)
 * so discovery failures are retried by the watcher's backoff loop.
 */
export class LocalResolvingTransport extends EventEmitter implements Transport {
  private resolvedPath: string | null = null;

  constructor(
    private readonly options: ResolveLocalOptions,
    readonly label: string,
  ) {
    super();
  }

  get socketPath(): string | null {
    return this.resolvedPath;
  }

  async connect(): Promise<Duplex> {
    const path = this.resolvedPath ?? (await resolveLocalSocket(this.options)).socketPath;
    this.resolvedPath = path;
    try {
      return await new LocalTransport(path, this.label).connect();
    } catch (err) {
      this.resolvedPath = null;
      throw err;
    }
  }

  async dispose(): Promise<void> {}
}
