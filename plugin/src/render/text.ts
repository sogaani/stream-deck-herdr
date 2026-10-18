/** Approximate rendered width in "half-width character" units. */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK, full-width forms, emoji and most symbols take two cells.
    width += code > 0x2e7f && !(code >= 0xff61 && code <= 0xff9f) ? 2 : 1;
  }
  return width;
}

export function truncate(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  let out = "";
  for (const ch of text) {
    if (textWidth(out + ch) > maxWidth - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Splits text into at most `lines` lines of `maxWidth` cells, breaking on spaces, `/`, `-`, `_` when possible. */
export function wrapLines(text: string, maxWidth: number, lines: number): string[] {
  const words = text.split(/(?<=[\s/_-])/).map((w) => w.trim()).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current}${word}` : word;
    if (textWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    current = word;
    if (out.length === lines) break;
  }
  if (out.length < lines && current) out.push(current);
  if (out.length > lines) out.length = lines;
  if (out.length === lines && textWidth(out[lines - 1] ?? "") > maxWidth) {
    out[lines - 1] = truncate(out[lines - 1] ?? "", maxWidth);
  } else if (out.length === lines) {
    const consumed = out.join("").length;
    if (consumed < text.replace(/\s+/g, "").length) out[lines - 1] = truncate(`${out[lines - 1] ?? ""}…`, maxWidth);
  }
  return out.map((line) => (textWidth(line) > maxWidth ? truncate(line, maxWidth) : line));
}

export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}
