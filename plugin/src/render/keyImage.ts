import type { AgentStatus } from "@stream-deck-herdr/herdr-client";
import { COLORS, STATUS_COLORS, STATUS_LABELS } from "./colors.js";
import { escapeXml, truncate, wrapLines } from "./text.js";

export interface KeyImageModel {
  kind: "agent" | "empty" | "offline" | "unbound";
  status?: AgentStatus;
  /** Main text, e.g. terminal title or workspace/tab. */
  title?: string;
  /** Small caption, e.g. agent kind. */
  caption?: string;
  /** Host label shown when several hosts are configured. */
  hostLabel?: string;
  /** Slot number for slot keys. */
  slot?: number;
  /** Short message for offline/unbound states. */
  message?: string;
}

const SIZE = 144;
const FONT = "-apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', Helvetica, Arial, sans-serif";

function text(x: number, y: number, content: string, size: number, color: string, opts: { weight?: number; anchor?: "start" | "middle" | "end" } = {}): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${opts.weight ?? 500}" fill="${color}" text-anchor="${opts.anchor ?? "start"}">${escapeXml(content)}</text>`;
}

export function renderKeySvg(model: KeyImageModel): string {
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`);
  parts.push(`<rect width="${SIZE}" height="${SIZE}" rx="18" fill="${COLORS.background}"/>`);

  if (model.kind === "agent" && model.status) {
    const color = STATUS_COLORS[model.status];
    parts.push(`<rect x="0" y="0" width="${SIZE}" height="34" rx="18" fill="${color}"/>`);
    parts.push(`<rect x="0" y="18" width="${SIZE}" height="16" fill="${color}"/>`);
    parts.push(text(12, 25, STATUS_LABELS[model.status], 17, "#11111b", { weight: 800 }));
    if (model.slot) parts.push(text(SIZE - 12, 25, `#${model.slot}`, 15, "#11111b", { weight: 700, anchor: "end" }));
    if (model.status === "blocked") {
      parts.push(`<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="18" fill="none" stroke="${color}" stroke-width="6"/>`);
    }
    const lines = wrapLines(model.title ?? "", 13, 2);
    lines.forEach((line, i) => parts.push(text(12, 66 + i * 24, line, 18, COLORS.text, { weight: 600 })));
    if (model.caption) parts.push(text(12, 120, truncate(model.caption, 14), 14, COLORS.subtext));
    if (model.hostLabel) parts.push(text(SIZE - 10, 136, truncate(model.hostLabel, 12), 12, COLORS.muted, { anchor: "end" }));
  } else if (model.kind === "empty") {
    parts.push(`<rect x="8" y="8" width="${SIZE - 16}" height="${SIZE - 16}" rx="14" fill="none" stroke="${COLORS.surface}" stroke-width="3" stroke-dasharray="8 6"/>`);
    if (model.slot) parts.push(text(SIZE / 2, 60, `#${model.slot}`, 22, COLORS.muted, { weight: 700, anchor: "middle" }));
    parts.push(text(SIZE / 2, model.slot ? 92 : 80, model.message ?? "—", 16, COLORS.muted, { anchor: "middle" }));
    if (model.hostLabel) parts.push(text(SIZE - 10, 136, truncate(model.hostLabel, 12), 12, COLORS.muted, { anchor: "end" }));
  } else if (model.kind === "offline") {
    parts.push(
      `<defs><pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="12" fill="${COLORS.surface}"/></pattern></defs>`,
    );
    parts.push(`<rect width="${SIZE}" height="${SIZE}" rx="18" fill="url(#hatch)"/>`);
    parts.push(`<rect x="0" y="0" width="${SIZE}" height="34" rx="18" fill="${COLORS.offline}"/>`);
    parts.push(`<rect x="0" y="18" width="${SIZE}" height="16" fill="${COLORS.offline}"/>`);
    parts.push(text(12, 25, "OFFLINE", 17, "#11111b", { weight: 800 }));
    if (model.slot) parts.push(text(SIZE - 12, 25, `#${model.slot}`, 15, "#11111b", { weight: 700, anchor: "end" }));
    wrapLines(model.message ?? "not connected", 15, 3).forEach((line, i) => parts.push(text(12, 64 + i * 20, line, 14, COLORS.text)));
    if (model.hostLabel) parts.push(text(SIZE - 10, 136, truncate(model.hostLabel, 12), 12, COLORS.muted, { anchor: "end" }));
  } else {
    parts.push(text(SIZE / 2, 66, model.message ?? "Herdr", 18, COLORS.subtext, { weight: 600, anchor: "middle" }));
    parts.push(text(SIZE / 2, 92, "configure in", 13, COLORS.muted, { anchor: "middle" }));
    parts.push(text(SIZE / 2, 110, "the inspector", 13, COLORS.muted, { anchor: "middle" }));
  }

  parts.push("</svg>");
  return parts.join("");
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function renderKeyImage(model: KeyImageModel): string {
  return svgToDataUri(renderKeySvg(model));
}
