import { agentsFor, detect, toSignals } from "../agents/index.js";
import type { AgentContext, Finding } from "../agents/types.js";
import { generate } from "../generator/generate.js";
import { localSignals } from "../signals/local.js";
import { openStore } from "../store/store.js";
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
  events: number; // replayed before the run ended
  findings: RunFinding[]; // every finding, shared or not
  signals: RiskSignal[]; // the shared ones (score ≥ 0.4)
};

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
  const store = await openStore();
  try {
    const ctx: AgentContext = { history: store, profile: profileLookup(accounts, events), uaShare: browserShares(accounts) };
    const signals = localSignals();
    for (const [seq, e] of events.entries()) {
      await processEvent(e, ctx, signals, record);
      await store.insert(e, seq);
      record.events = seq + 1;
    }
  } catch (err) {
    record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
  } finally {
    await store.close();
    record.finishedAt = new Date().toISOString();
  }
  return record;
}

async function processEvent(e: TripwireEvent, ctx: AgentContext, signals: ReturnType<typeof localSignals>, record: RunRecord) {
  for (const agent of agentsFor(e)) {
    const findings = await detect(agent, e, ctx, signals.recall);
    record.findings.push(...findings.map((f) => ({ ...f, agent: agent.name, eventId: e.id })));
    for (const s of toSignals(agent.name, e, findings)) {
      await signals.write(s);
      record.signals.push(s);
    }
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
