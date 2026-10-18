import streamDeck, {
  action,
  SingletonAction,
  type DialAction as SdDialAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
  type DidReceiveSettingsEvent,
  type PropertyInspectorDidAppearEvent,
  type SendToPluginEvent,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { dialFeedback } from "../render/dialFeedback.js";
import { ALL_HOSTS, pressActionFor, type DialActionSettings } from "../settings.js";
import type { AgentRef } from "../store/AgentStore.js";
import type { PluginContext } from "./context.js";
import { agentItems, handleInspectorMessage, type InspectorMessage } from "./inspector.js";
import { performPress } from "./performPress.js";
import { PressGesture, type PressKind } from "./pressGesture.js";

type Settings = DialActionSettings & JsonObject;

interface View {
  action: SdDialAction<Settings>;
  settings: Settings;
  /** `${hostId}|${paneId}` of the highlighted agent. */
  selected: string | null;
  lastFeedback: string | null;
}

const keyOf = (ref: AgentRef) => `${ref.hostId}|${ref.agent.pane_id}`;

/** Stream Deck + dial: rotate through agents, press / hold run the configured actions, tap focuses. */
@action({ UUID: "com.sogaani.herdr.dial" })
export class AgentDialAction extends SingletonAction<Settings> {
  private readonly views = new Map<string, View>();
  private readonly gesture = new PressGesture();

  constructor(private readonly ctx: PluginContext) {
    super();
    ctx.store.on("change", () => {
      for (const id of this.views.keys()) this.render(id);
    });
  }

  private hostIdOf(settings: Settings): string {
    return settings.hostId ?? ALL_HOSTS;
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (!ev.action.isDial()) return;
    const settings = (ev.payload.settings ?? {}) as Settings;
    this.views.set(ev.action.id, { action: ev.action, settings, selected: null, lastFeedback: null });
    this.ctx.registry.acquire(ev.action.id, this.hostIdOf(settings));
    this.render(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.views.delete(ev.action.id);
    this.gesture.cancel(ev.action.id);
    this.ctx.registry.release(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    const view = this.views.get(ev.action.id);
    if (!view) return;
    view.settings = (ev.payload.settings ?? {}) as Settings;
    view.selected = null;
    this.ctx.registry.acquire(ev.action.id, this.hostIdOf(view.settings));
    this.render(ev.action.id);
  }

  override onDialRotate(ev: DialRotateEvent<Settings>): void {
    const view = this.views.get(ev.action.id);
    if (!view) return;
    const refs = this.ctx.store.sorted(this.hostIdOf(view.settings));
    if (refs.length === 0) return;
    const current = this.indexOf(view, refs);
    const next = Math.min(refs.length - 1, Math.max(0, current + ev.payload.ticks));
    view.selected = keyOf(refs[next]!);
    this.render(ev.action.id);
  }

  override onDialDown(ev: DialDownEvent<Settings>): void {
    this.gesture.down(ev.action.id, () => void this.press(ev.action.id, "long"));
  }

  override onDialUp(ev: DialUpEvent<Settings>): void {
    if (this.gesture.up(ev.action.id) === "short") void this.press(ev.action.id, "short");
  }

  override onTouchTap(ev: TouchTapEvent<Settings>): void {
    void this.press(ev.action.id, ev.payload.hold ? "long" : "focus");
  }

  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<Settings>): Promise<void> {
    const view = this.views.get(ev.action.id);
    const hostId = view ? this.hostIdOf(view.settings) : "";
    await streamDeck.ui.sendToPropertyInspector({ event: "getAgents", items: agentItems(this.ctx, hostId) });
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
    const view = this.views.get(ev.action.id);
    const reply = async (payload: Record<string, unknown>) => {
      await streamDeck.ui.sendToPropertyInspector(payload as JsonValue);
    };
    await handleInspectorMessage(this.ctx, ev.payload as unknown as InspectorMessage, reply, {
      allowAllHosts: true,
      currentHostId: view ? this.hostIdOf(view.settings) : undefined,
    });
  }

  private indexOf(view: View, refs: AgentRef[]): number {
    if (!view.selected) return 0;
    const index = refs.findIndex((r) => keyOf(r) === view.selected);
    return index >= 0 ? index : 0;
  }

  private render(contextId: string): void {
    const view = this.views.get(contextId);
    if (!view) return;
    const hostId = this.hostIdOf(view.settings);
    const refs = this.ctx.store.sorted(hostId);
    const index = this.indexOf(view, refs);
    const ref = refs[index];
    if (ref) view.selected = keyOf(ref);
    const feedback = dialFeedback({
      agent: ref?.agent ?? null,
      state: ref?.state ?? null,
      index,
      total: refs.length,
      hostLabel: this.ctx.store.hostCount() > 1 || !hostId ? (ref?.hostLabel ?? this.ctx.store.hostLabel(hostId)) : undefined,
      offlineMessage: refs.length === 0 ? (this.ctx.store.offlineMessage(hostId) ?? undefined) : undefined,
    });
    const serialized = JSON.stringify(feedback);
    if (serialized === view.lastFeedback) return;
    view.lastFeedback = serialized;
    view.action.setFeedback(feedback as never).catch((err: unknown) => this.ctx.logger.warn(`[herdr] setFeedback failed: ${String(err)}`));
  }

  private async press(contextId: string, kind: PressKind | "focus"): Promise<void> {
    const view = this.views.get(contextId);
    if (!view) return;
    const refs = this.ctx.store.sorted(this.hostIdOf(view.settings));
    const ref = refs[this.indexOf(view, refs)];
    const conn = ref ? this.ctx.registry.get(ref.hostId) : undefined;
    if (!ref || !conn) {
      await view.action.showAlert();
      return;
    }
    const action = kind === "focus" ? "focus" : pressActionFor(view.settings, kind);
    const outcome = await performPress(conn, ref.agent, action, view.settings, this.ctx.logger);
    this.ctx.logger.info(`[herdr] dial ${kind} (${action}) → ${outcome.action}: ${outcome.message}`);
    if (!outcome.ok) await view.action.showAlert();
  }
}
