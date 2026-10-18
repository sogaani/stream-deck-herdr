import { action } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { agentLabels } from "../render/agentView.js";
import type { AgentActionSettings } from "../settings.js";
import type { AgentRef } from "../store/AgentStore.js";
import { KeyAgentActionBase } from "./keyActionBase.js";

type Settings = AgentActionSettings & JsonObject;

/** A key bound to one specific Herdr agent. */
@action({ UUID: "com.sogaani.herdr.agent" })
export class AgentAction extends KeyAgentActionBase<Settings> {
  protected hostIdOf(settings: Settings): string {
    return settings.hostId ?? "";
  }

  protected allowAllHosts(): boolean {
    return false;
  }

  protected resolve(settings: Settings): AgentRef | undefined {
    const hostId = this.hostIdOf(settings);
    if (!hostId || !settings.paneId) return undefined;
    return this.ctx.store.find(hostId, settings.paneId, settings.sessionId);
  }

  /** Remember the agent's native session id and label so the key survives pane id changes. */
  protected override onSettingsChanged(view: { action: { setSettings(s: Settings): Promise<void> }; settings: Settings }): void {
    const ref = this.resolve(view.settings);
    if (!ref) return;
    const sessionId = ref.agent.agent_session?.value;
    const agentLabel = agentLabels(ref.agent, ref.state).title;
    const paneId = ref.agent.pane_id;
    if (view.settings.sessionId === sessionId && view.settings.agentLabel === agentLabel && view.settings.paneId === paneId) return;
    view.settings = { ...view.settings, paneId, sessionId, agentLabel };
    void view.action.setSettings(view.settings);
  }

  protected override renderAll(): void {
    // Re-bind keys whose pane id vanished but whose session is still around.
    for (const view of this.views.values()) {
      const settings = view.settings;
      if (!settings.hostId || !settings.sessionId) continue;
      const ref = this.ctx.store.find(settings.hostId, settings.paneId, settings.sessionId);
      if (ref && ref.agent.pane_id !== settings.paneId) this.onSettingsChanged(view);
    }
    super.renderAll();
  }
}
