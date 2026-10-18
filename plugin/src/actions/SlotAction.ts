import { action } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { slotAt } from "@stream-deck-herdr/herdr-client";
import { ALL_HOSTS, type SlotActionSettings } from "../settings.js";
import type { AgentRef } from "../store/AgentStore.js";
import { KeyAgentActionBase } from "./keyActionBase.js";

type Settings = SlotActionSettings & JsonObject;

/** A key showing the N-th agent in attention order (blocked first). */
@action({ UUID: "com.sogaani.herdr.slot" })
export class SlotAction extends KeyAgentActionBase<Settings> {
  protected hostIdOf(settings: Settings): string {
    return settings.hostId ?? ALL_HOSTS;
  }

  protected allowAllHosts(): boolean {
    return true;
  }

  protected override slotOf(settings: Settings): number {
    const slot = Number(settings.slot);
    return Number.isInteger(slot) && slot >= 1 ? slot : 1;
  }

  protected resolve(settings: Settings): AgentRef | undefined {
    const refs = this.ctx.store.sorted(this.hostIdOf(settings));
    const agents = refs.map((r) => r.agent);
    const agent = slotAt(agents, this.slotOf(settings));
    return agent ? refs[agents.indexOf(agent)] : undefined;
  }
}
