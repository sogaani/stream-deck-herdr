import streamDeck, {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type PropertyInspectorDidAppearEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { renderKeyImage, type KeyImageModel } from "../render/keyImage.js";
import { pressActionFor, type PressSettings } from "../settings.js";
import type { AgentRef } from "../store/AgentStore.js";
import type { PluginContext } from "./context.js";
import { agentItems, handleInspectorMessage, type InspectorMessage } from "./inspector.js";
import { agentKeyModel } from "./keyView.js";
import { performPress } from "./performPress.js";
import { PressGesture, type PressKind } from "./pressGesture.js";

interface View<S> {
  action: KeyAction<S & JsonObject>;
  settings: S;
  lastImage: string | null;
}

/**
 * Shared behaviour of the key actions: track visible contexts, render the
 * agent image on store changes, and translate presses into Herdr commands.
 */
export abstract class KeyAgentActionBase<S extends PressSettings & JsonObject> extends SingletonAction<S> {
  protected readonly views = new Map<string, View<S>>();
  private readonly gesture = new PressGesture();

  constructor(protected readonly ctx: PluginContext) {
    super();
    ctx.store.on("change", () => this.renderAll());
  }

  /** Host the settings point at (`""` = all hosts). */
  protected abstract hostIdOf(settings: S): string;
  /** Whether the property inspector may offer "All hosts". */
  protected abstract allowAllHosts(): boolean;
  /** Resolves the agent currently shown by this key. */
  protected abstract resolve(settings: S): AgentRef | undefined;
  /** Slot number to print on the key, when any. */
  protected slotOf(_settings: S): number | undefined {
    return undefined;
  }
  /** Hook for subclasses when settings change (e.g. to enrich them). */
  protected onSettingsChanged(_view: View<S>): void {}

  override onWillAppear(ev: WillAppearEvent<S>): void {
    if (!ev.action.isKey()) return;
    const settings = (ev.payload.settings ?? {}) as S;
    const view: View<S> = { action: ev.action as KeyAction<S & JsonObject>, settings, lastImage: null };
    this.views.set(ev.action.id, view);
    this.ctx.registry.acquire(ev.action.id, this.hostIdOf(settings));
    this.onSettingsChanged(view);
    this.render(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent<S>): void {
    this.views.delete(ev.action.id);
    this.gesture.cancel(ev.action.id);
    this.ctx.registry.release(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): void {
    const view = this.views.get(ev.action.id);
    if (!view) return;
    view.settings = (ev.payload.settings ?? {}) as S;
    this.ctx.registry.acquire(ev.action.id, this.hostIdOf(view.settings));
    this.onSettingsChanged(view);
    this.render(ev.action.id);
  }

  override onKeyDown(ev: KeyDownEvent<S>): void {
    this.gesture.down(ev.action.id, () => void this.press(ev.action.id, "long"));
  }

  override onKeyUp(ev: KeyUpEvent<S>): void {
    if (this.gesture.up(ev.action.id) === "short") void this.press(ev.action.id, "short");
  }

  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<S>): Promise<void> {
    const view = this.views.get(ev.action.id);
    const hostId = view ? this.hostIdOf(view.settings) : "";
    await streamDeck.ui.sendToPropertyInspector({ event: "getAgents", items: agentItems(this.ctx, hostId) });
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, S>): Promise<void> {
    const view = this.views.get(ev.action.id);
    const reply = async (payload: Record<string, unknown>) => {
      await streamDeck.ui.sendToPropertyInspector(payload as JsonValue);
    };
    await handleInspectorMessage(this.ctx, ev.payload as unknown as InspectorMessage, reply, {
      allowAllHosts: this.allowAllHosts(),
      currentHostId: view ? this.hostIdOf(view.settings) : undefined,
    });
  }

  protected renderAll(): void {
    for (const id of this.views.keys()) this.render(id);
  }

  protected modelFor(view: View<S>): KeyImageModel {
    if (!this.hostIdOf(view.settings) && !this.allowAllHosts()) {
      return { kind: "unbound", message: "Herdr" };
    }
    return agentKeyModel(this.ctx.store, this.hostIdOf(view.settings), this.resolve(view.settings), this.slotOf(view.settings));
  }

  protected render(contextId: string): void {
    const view = this.views.get(contextId);
    if (!view) return;
    const image = renderKeyImage(this.modelFor(view));
    if (image === view.lastImage) return;
    view.lastImage = image;
    view.action.setImage(image).catch((err: unknown) => this.ctx.logger.warn(`[herdr] setImage failed: ${String(err)}`));
  }

  private async press(contextId: string, kind: PressKind): Promise<void> {
    const view = this.views.get(contextId);
    if (!view) return;
    const ref = this.resolve(view.settings);
    const conn = ref ? this.ctx.registry.get(ref.hostId) : undefined;
    if (!ref || !conn) {
      await view.action.showAlert();
      return;
    }
    const action = pressActionFor(view.settings, kind);
    const outcome = await performPress(conn, ref.agent, action, view.settings, this.ctx.logger);
    this.ctx.logger.info(`[herdr] ${kind} press (${action}) → ${outcome.action}: ${outcome.message}`);
    if (outcome.ok) await view.action.showOk();
    else await view.action.showAlert();
  }
}
