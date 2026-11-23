import { entitiesOf, type Recall } from "../agents/index.js";
import type { AgentName, RiskSignal, TripwireEvent } from "../types.js";

export const RECALL_WINDOW_MS = 72 * 3_600_000; // PRD C2: signals older than 72 h don't count

export type SignalStore = { write(s: RiskSignal): Promise<void>; recall: Recall };

/** Same account, or a shared device, IP or payee, inside the recall window. ON mode (M2) applies the same test to Meko results. */
export function isRelevant(s: RiskSignal, e: TripwireEvent): boolean {
  const age = Date.parse(e.ts) - Date.parse(s.ts);
  if (age < 0 || age > RECALL_WINDOW_MS) return false;
  const ent = entitiesOf(e);
  return s.accountId === e.accountId || sharedValue(s.entities.deviceId, ent.deviceId) || sharedValue(s.entities.ip, ent.ip)
    || sharedValue(s.entities.payeeId, ent.payeeId);
}

const sharedValue = (a: string | undefined, b: string | undefined) => a !== undefined && a === b;

/** OFF mode (PRD R4): each agent keeps its own signals in process and recalls only those. */
export function localSignals(): SignalStore {
  const byAgent = new Map<AgentName, RiskSignal[]>();
  return {
    async write(s) {
      const own = byAgent.get(s.agent) ?? [];
      own.push(s);
      byAgent.set(s.agent, own);
    },
    async recall(agent, e) {
      return (byAgent.get(agent) ?? []).filter((s) => isRelevant(s, e));
    },
  };
}
