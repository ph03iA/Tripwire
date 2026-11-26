import type { TripwireEvent } from "../types.js";
import { inLoginAttack, PATTERN_WINDOW_MS, patternReadings } from "./readings.js";
import type { Reading } from "./review.js";

export const BATCH_SIZE = 50;

/** Why a batch was reviewed: a decision that needs the model's view, the pattern alarm, a full batch, or the end of the stream. */
export type Closer = "decision" | "alarm" | "size" | "end";
export type Taken = { events: TripwireEvent[]; readings: Reading[]; patterns: string[] };
export type AgentBatch = {
  size(): number;
  /** Adds an event the agent handled, with the agent's rule readings on it. */
  add(e: TripwireEvent, readings: Reading[]): void;
  /** Whether the batch, which ends with `e`, must be reviewed before e's decision, and why. */
  closer(e: TripwireEvent, decidedWithEvidence: boolean): Closer | null;
  take(uaShare: (ua: string) => number): Taken;
};

/**
 * The events one agent has handled that its model hasn't reviewed yet (M2.5). Batches wait until they're full, except
 * when the event just added can't wait: it gets a decision with evidence on an account, device, IP address or payee the
 * batch already holds, so the model's view of them reaches that decision; or it trips the pattern alarm. Waiting keeps
 * a run near 200 batch calls instead of 726, which no free tier holds in a day (measured on seed 42).
 */
export function agentBatch(): AgentBatch {
  let pending: TripwireEvent[] = [];
  let readings: Reading[] = [];
  let recent: TripwireEvent[] = []; // the agent's last hour of events, reviewed or not: what pattern readings cover
  return {
    size: () => pending.length,
    add(e, own) {
      pending.push(e);
      readings.push(...own);
      recent = [...recent.filter((x) => Date.parse(e.ts) - Date.parse(x.ts) <= PATTERN_WINDOW_MS), e];
    },
    closer(e, decidedWithEvidence) {
      if (inLoginAttack(e, recent)) return "alarm";
      if (decidedWithEvidence && pending.some((x) => x.id !== e.id && related(x, e))) return "decision";
      return pending.length >= BATCH_SIZE ? "size" : null;
    },
    take(uaShare) {
      const taken = { events: pending, readings, patterns: patternReadings(recent, uaShare) };
      pending = [];
      readings = [];
      return taken;
    },
  };
}

const links = (e: TripwireEvent) =>
  [e.accountId, "deviceId" in e ? e.deviceId : undefined, "ip" in e ? e.ip : undefined, e.kind === "transaction" ? e.payeeId : undefined];

/** Same account, device, IP address or payee. */
function related(a: TripwireEvent, b: TripwireEvent): boolean {
  const mine = new Set(links(a).filter((v) => v !== undefined));
  return links(b).some((v) => v !== undefined && mine.has(v));
}
