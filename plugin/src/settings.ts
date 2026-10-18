import type { PressKind } from "./actions/pressGesture.js";

export type SshAuthSettings =
  | { type: "password"; username: string; password: string }
  | { type: "key"; username: string; identityFile: string; passphrase?: string }
  | { type: "agent"; username: string };

export type LocalHostConfig = {
  id: string;
  label: string;
  mode: "local";
  session?: string;
  socketPath?: string;
  herdrBinary?: string;
};

export type SshHostConfig = {
  id: string;
  label: string;
  mode: "ssh";
  host: string;
  port?: number;
  auth: SshAuthSettings;
  remoteSession?: string;
  remoteSocketPath?: string;
  /** Learned host key fingerprint (`SHA256:…`). */
  knownHostKey?: string;
};

export type HostConfig = LocalHostConfig | SshHostConfig;

/** Stored by Stream Deck as plain JSON; shared by every action of this plugin. */
export type GlobalSettings = {
  hosts?: HostConfig[];
};

/** What a press does: type the approve keys, type the deny keys, or focus the pane. */
export type PressAction = "approve" | "decline" | "focus";

export const PRESS_ACTIONS: readonly PressAction[] = ["approve", "decline", "focus"];

/** Settings shared by the key and dial actions. */
export type PressSettings = {
  /** Space separated Herdr key names sent to approve, default `enter`. */
  approveKeys?: string;
  /** Space separated Herdr key names sent to deny, default `esc`. */
  denyKeys?: string;
  /** Only send keys when the agent is actually blocked (default true); otherwise focus the pane. */
  requireBlocked?: boolean;
  /** Action for a short press (dial push). Default `approve`. */
  shortPress?: PressAction;
  /** Action for a long press (dial hold / long touch). Default `decline`. */
  longPress?: PressAction;
};

export type AgentActionSettings = PressSettings & {
  hostId?: string;
  paneId?: string;
  /** Native agent session id, used to re-bind when the pane id changed. */
  sessionId?: string;
  /** Display label captured when the agent was selected. */
  agentLabel?: string;
};

export type SlotActionSettings = PressSettings & {
  /** Empty string or undefined means every configured host. */
  hostId?: string;
  slot?: number;
};

export type DialActionSettings = PressSettings & {
  hostId?: string;
};

export const ALL_HOSTS = "";

export function parseKeys(value: string | undefined, fallback: string): string[] {
  const keys = (value ?? "")
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : fallback.split(" ");
}

export function approveKeys(settings: PressSettings): string[] {
  return parseKeys(settings.approveKeys, "enter");
}

export function denyKeys(settings: PressSettings): string[] {
  return parseKeys(settings.denyKeys, "esc");
}

export function requireBlocked(settings: PressSettings): boolean {
  return settings.requireBlocked !== false;
}

/** Resolves the configured action for a press kind, falling back to approve (short) / decline (long). */
export function pressActionFor(settings: PressSettings, kind: PressKind): PressAction {
  const configured = kind === "short" ? settings.shortPress : settings.longPress;
  if (configured && (PRESS_ACTIONS as readonly string[]).includes(configured)) return configured;
  return kind === "short" ? "approve" : "decline";
}

/** Validates a host config coming from the property inspector. Returns an error message or null. */
export function validateHostConfig(host: Partial<HostConfig> | undefined): string | null {
  if (!host || typeof host !== "object") return "host is missing";
  if (!host.id) return "host id is missing";
  if (!host.label?.trim()) return "label is required";
  if (host.mode === "local") return null;
  if (host.mode === "ssh") {
    if (!host.host?.trim()) return "host name or IP address is required";
    const auth = host.auth as SshAuthSettings | undefined;
    if (!auth?.username?.trim()) return "SSH username is required";
    if (auth.type === "password" && !auth.password) return "password is required";
    if (auth.type === "key" && !auth.identityFile?.trim()) return "identity file path is required";
    return null;
  }
  return "unknown host mode";
}
