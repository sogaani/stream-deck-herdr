export type PressKind = "short" | "long";

interface Pending {
  timer: NodeJS.Timeout;
  fired: boolean;
}

/**
 * Distinguishes short presses from long presses per action context. The long
 * press fires as soon as the threshold elapses, without waiting for release.
 */
export class PressGesture {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly longPressMs = 600) {}

  down(context: string, onLong: () => void): void {
    this.cancel(context);
    const entry: Pending = {
      fired: false,
      timer: setTimeout(() => {
        entry.fired = true;
        onLong();
      }, this.longPressMs),
    };
    this.pending.set(context, entry);
  }

  /** Returns `"short"` when the release should trigger the short action. */
  up(context: string): PressKind | null {
    const entry = this.pending.get(context);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.pending.delete(context);
    return entry.fired ? null : "short";
  }

  cancel(context: string): void {
    const entry = this.pending.get(context);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(context);
  }
}
