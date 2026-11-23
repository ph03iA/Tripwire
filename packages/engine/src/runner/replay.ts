import { agentsFor, detect, toSignals } from "../agents/index.js";
import type { AgentContext, Finding } from "../agents/types.js";
import { generate } from "../generator/generate.js";
import { localSignals, type SignalStore } from "../signals/local.js";
import { openStore, type EventStore } from "../store/store.js";
import type { AccountProfile, AgentName, RiskSignal, TripwireEvent } from "../types.js";

export type RunFinding = Finding & { agent: AgentName; eventId: string };

export type RunRecord = {
  runId: string;
  seed: number;
  meko: "off";
  status: "ok" | "failed";
  error?: string;
  startedAt: string;
  finishedAt: string;
  events: number; // stored before the run ended
  findings: RunFinding[]; // every finding on a stored event, shared or not
  signals: RiskSignal[]; // the shared ones (score ≥ 0.4)
};

type Staged = { findings: RunFinding[]; signals: RiskSignal[] };

/**
 * Replays a seeded stream through the detection agents in OFF mode (PRD R1, R4, R6). For each event the agents run
 * first and the event is stored after, so no agent can see the present or the future. Any error stops the run and is
 * recorded, never swallowed: a partial run must not pass for a complete one.
 */
export const replay = (seed: number) => replayStream({ seed, ...generate(seed) });

export async function replayStream({ seed, events, accounts }: { seed: number; events: TripwireEvent[]; accounts: AccountProfile[] }): Promise<RunRecord> {
  const startedAt = new Date().toISOString(); // wall clock for the record only; decisions use event time
  const record: RunRecord = { runId: `${seed}-off-${startedAt.replace(/[:.]/g, "-")}`, seed, meko: "off", status: "ok", startedAt,
    finishedAt: startedAt, events: 0, findings: [], signals: [] };
  let store: EventStore | undefined;
  try {
    assertInTimeOrder(events);
    const ctx: AgentContext = { history: (store = await openStore()), profile: profileLookup(accounts, events), uaShare: browserShares(accounts) };
    const signals = localSignals();
    for (const [seq, e] of events.entries()) {
      const staged = await detectAll(e, ctx, signals);
      await store.insert(e, seq); // if this fails, nothing from the event reaches the record or the signal store
      await publish(staged, signals, record);
      record.events = seq + 1;
    }
  } catch (err) {
    fail(record, err);
  } finally {
    await store?.close().catch((err: unknown) => fail(record, err));
    record.finishedAt = new Date().toISOString();
  }
  return record;
}

/** Every agent that sees the event, against signals from earlier events only. */
async function detectAll(e: TripwireEvent, ctx: AgentContext, signals: SignalStore): Promise<Staged> {
  const staged: Staged = { findings: [], signals: [] };
  for (const agent of agentsFor(e)) {
    const findings = await detect(agent, e, ctx, signals.recall);
    staged.findings.push(...findings.map((f) => ({ ...f, agent: agent.name, eventId: e.id })));
    staged.signals.push(...toSignals(agent.name, e, findings));
  }
  return staged;
}

async function publish(staged: Staged, signals: SignalStore, record: RunRecord) {
  for (const s of staged.signals) await signals.write(s);
  record.findings.push(...staged.findings);
  record.signals.push(...staged.signals);
}

/** Keeps the first error: later ones (a close after a failure, say) are consequences. */
function fail(record: RunRecord, err: unknown) {
  if (record.status === "failed") return;
  record.status = "failed";
  record.error = err instanceof Error ? err.message : String(err);
}

/** Agents may only see the past, so the stream must be in time order. Equal times keep their input order. */
function assertInTimeOrder(events: TripwireEvent[]) {
  let previous = -Infinity;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) throw new Error(`event ${e.id} has an invalid timestamp "${e.ts}"`);
    if (t < previous) throw new Error(`event ${e.id} at ${e.ts} is earlier than the event before it; the stream must be in time order`);
    previous = t;
  }
}

/** Every event's account must have a profile: a missing one means the input is broken, not that the account is new. */
function profileLookup(accounts: AccountProfile[], events: TripwireEvent[]): AgentContext["profile"] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const missing = events.find((e) => !byId.has(e.accountId));
  if (missing) throw new Error(`event ${missing.id} names ${missing.accountId}, which has no profile`);
  return (id) => byId.get(id);
}

/** Share of all known devices that use each browser string. */
function browserShares(accounts: AccountProfile[]): AgentContext["uaShare"] {
  const devices = accounts.flatMap((a) => a.knownDevices);
  const counts = new Map<string, number>();
  for (const d of devices) counts.set(d.userAgent, (counts.get(d.userAgent) ?? 0) + 1);
  return (ua) => (counts.get(ua) ?? 0) / devices.length;
}
