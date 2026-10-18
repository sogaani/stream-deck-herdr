import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

/**
 * Produces byte streams connected to a Herdr API socket.
 *
 * Every `connect()` call yields an independent stream so callers can keep one
 * request/response connection and several long-lived subscription connections.
 *
 * Events:
 * - `close` (err?: Error): the underlying link (e.g. an SSH session) went away;
 *   streams obtained earlier are dead and the owner should reconnect.
 * - `hostkey` (fingerprint: string): an SSH host key was learned on first use.
 */
export interface Transport extends EventEmitter {
  readonly label: string;
  connect(): Promise<Duplex>;
  dispose(): Promise<void>;
}
