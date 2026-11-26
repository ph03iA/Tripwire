import { type Action, decide, triggerOf, type Trigger, type Verdict } from "../agents/decision.js";
import { agentsFor, detect, OWNER, toSignals } from "../agents/index.js";
import type { AgentContext, Finding } from "../agents/types.js";
import { generate } from "../generator/generate.js";
import type { Mcp } from "../meko/mcp.js";
import type { Wait } from "../meko/retry.js";
import { type Metrics, scoreRun } from "../metrics.js";
import { localSignals, type SignalStore } from "../signals/local.js";
import { mekoSignals, type Retrieval } from "../signals/meko.js";
import { openStore, type EventStore } from "../store/store.js";
import type { AccountProfile, AgentName, Label, RiskSignal, StepUpResultEvent, TripwireEvent } from "../types.js";
import { type Denial, type Locks, locks, otpPasses } from "./outcomes.js";
import { type KnowledgeDocuments, noTrace, openTrace, type Quote, type Trace } from "./trace.js";

export type RunFinding = Finding & { agent: AgentName; eventId: string };

/** What became of a reviewed event: allowed, through or stopped at its step-up, or blocked. */
export type Outcome = "allowed" | "passed" | "failed" | "blocked";

/** One decision and why (PRD C3). OFF mode has no quotes, retrievals or trace. */
export type Decision = {
  eventId: string;
  accountId: string;
  ts: string;
  trigger: Trigger;
  action: Action;
  risk: number;
  capped: boolean;
  signalsUsed: string[]; // "<eventId>/<ruleId>" of the strongest signal of each type
  rulesApplied: string[]; // the rules behind those signals, then the policy rule
  reasoning: string;
  quotes: Quote[]; // the playbook and policy passages, on a STEP-UP or BLOCK (C3)
  missingQuotes?: ("playbook" | "policy")[]; // a required passage that no search returned from its document
  retrievals: Retrieval[]; // every Meko search made for the event
  conversationId?: string; // the account's case, which holds the trace turn (C4)
  outcome: Outcome;
  latencyMs: number; // wall time, searches included; reported only: no decision reads the clock
};

export type RunRecord = {
  runId: string;
  seed: number;
  meko: "off" | "dry" | "on";
  status: "ok" | "failed";
  error?: string;
  startedAt: string;
  finishedAt: string;
  events: number; // stream events handled before the run ended: stored, or refused after a stop
  findings: RunFinding[]; // every finding on a stored event, shared or not
  signals: RiskSignal[]; // the shared ones (score ≥ 0.4)
  decisions: Decision[];
  denied: Denial[]; // refused after a stop (R2): never scored or stored
  stepUps: StepUpResultEvent[]; // the runner's answer to each STEP-UP (R3)
  metrics?: Metrics; // only on a run that finished
  audit?: Audit; // R8, on every ON or dry run, failed ones included
  conversations?: { run: string; ledger: string; cases: Record<string, string> };
  retrievals?: Retrieval[]; // every Meko search of the run, including those for events without a decision (C5)
  mekoCalls?: Record<string, number>; // attempts by tool, retries included, for the quota ledger (R7)
};

/** Whether the R8 audit passed: what it kept and deleted, or why it couldn't vouch for the datapack. */
export type Audit = { passed: true; kept: number; deleted: number } | { passed: false; error: string };

/** How an ON run reaches Meko; a dry run gets the in-process stand-in (meko/dry.ts). */
export type MekoRun = {
  mode: "dry" | "on";
  mcp: Mcp;
  datapacks: { signals: string; patterns: string };
  documents: KnowledgeDocuments; // the uploaded policy and playbooks, which every quote must come from
  wait?: Wait;
  now?: () => number;
  progress?: (line: string) => void;
};

type Staged = { findings: RunFinding[]; signals: RiskSignal[] };
type World = {
  ctx: AgentContext;
  signals: SignalStore;
  store: EventStore;
  locks: Locks;
  trace: Trace;
  label(id: string): Label;
  record: RunRecord;
  seq: number;
};
export type Stream = { seed: number; events: TripwireEvent[]; labels: Label[]; accounts: AccountProfile[] };

/**
 * Replays a seeded stream (PRD R1, R4, R6): the detection agents, the decision agent, and the world's answer to each
 * decision (R2, R3). OFF mode makes no Meko calls; with `meko`, signals, traces and the ledger go through Meko. For each event the agents run first and the event is stored after, so no agent
 * can see the present or the future. Any error stops the run and is recorded, never swallowed: a partial run must not
 * pass for a complete one.
 */
export const replay = (seed: number) => replayStream({ seed, ...generate(seed) });

export async function replayStream({ seed, events, labels, accounts }: Stream, meko?: MekoRun): Promise<RunRecord> {
  const startedAt = new Date().toISOString(); // wall clock for the record only; decisions use event time
  const mode = meko?.mode ?? "off";
  const record: RunRecord = { runId: `${seed}-${mode}-${startedAt.replace(/[:.]/g, "-")}`, seed, meko: mode, status: "ok", startedAt,
    finishedAt: startedAt, events: 0, findings: [], signals: [], decisions: [], denied: [], stepUps: [] };
  let store: EventStore | undefined;
  let session: Session | undefined;
  try {
    assertInTimeOrder(events);
    const label = labelLookup(labels, events);
    const profile = profileLookup(accounts, events);
    session = await sessionFor(meko, record.runId);
    store = await openStore();
    const world: World = { ctx: { history: store, profile, uaShare: browserShares(accounts) }, signals: session.signals, store,
      locks: locks(profile), trace: session.trace, label, record, seq: 0 };
    for (const e of events) {
      await replayEvent(e, world);
      record.events++;
    }
    record.metrics = scoreRun({ decisions: record.decisions, refused: refusedIds(record) }, events, labels);
  } catch (err) {
    fail(record, err);
  } finally {
    await auditInto(record, session);
    await store?.close().catch((err: unknown) => fail(record, err));
    if (meko) Object.assign(record, { conversations: session?.trace.conversations(), retrievals: session?.trace.retrievals(),
      mekoCalls: Object.fromEntries(meko.mcp.calls) });
    record.finishedAt = new Date().toISOString();
  }
  return record;
}

type Session = { trace: Trace; signals: SignalStore; finish(): Promise<{ kept: number; deleted: number } | undefined> };

/**
 * R8: the audit runs after a failed run too, so nothing Meko mined from its turns stays behind. A failed run keeps its
 * first error, and the record says whether the cleanup worked.
 */
async function auditInto(record: RunRecord, session: Session | undefined) {
  try {
    const audit = await session?.finish();
    if (audit) record.audit = { passed: true, ...audit };
  } catch (err) {
    record.audit = { passed: false, error: err instanceof Error ? err.message : String(err) };
    fail(record, err);
  }
}

/** OFF mode keeps signals in process and traces nothing; ON and dry runs go through Meko, then end with the R8 audit. */
async function sessionFor(meko: MekoRun | undefined, runId: string): Promise<Session> {
  if (!meko) return { trace: noTrace, signals: localSignals(), finish: async () => undefined };
  const trace = await openTrace({ ...meko, runId });
  const signals = mekoSignals({ mcp: meko.mcp, datapackId: meko.datapacks.signals, run: trace.run, caseFor: trace.caseFor, log: trace.log,
    wait: meko.wait, now: meko.now });
  return { trace, signals, finish: () => trace.finish(signals.trusted) };
}

async function replayEvent(e: TripwireEvent, w: World) {
  const denial = w.locks.deny(e);
  if (denial) {
    w.record.denied.push(denial); // refused at the door, so no agent sees it and it isn't stored
    return w.trace.ledger(e.ts, ledgerLine(e, `REFUSED by ${denial.rule} after ${denial.stopEventId}`));
  }
  const staged = await detectAll(e, w.ctx, w.signals);
  await w.store.insert(e, w.seq++); // if this fails, nothing from the event reaches the record or the signal store
  await publish(staged, w.signals, w.record);
  await review(e, staged.signals, w);
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

/**
 * The decision agent on a stored event (PRD C1–C3), then the world's answer (R2, R3). It sees what its mode allows:
 * in OFF mode only the signals of the agent that owns the event, from earlier events and from this one. A STEP-UP or
 * BLOCK gets its own trace turn (C4); every other event goes into the day's allow ledger (C5).
 */
async function review(e: TripwireEvent, onEvent: RiskSignal[], w: World) {
  const owner = OWNER[e.kind];
  const visible = owner ? onEvent.filter((s) => w.signals.sees(owner, s)) : [];
  const trigger = owner && triggerOf(e, visible);
  if (!owner || !trigger) return w.trace.ledger(e.ts, ledgerLine(e, "ALLOW unreviewed", onEvent, w.trace.retrievalsFor(e.id)));
  const t0 = performance.now();
  const verdict = decide(e, [...(await w.signals.forDecision(owner, e)), ...visible], w.ctx.profile(e.accountId));
  const { quotes, missing } = verdict.action === "ALLOW" ? { quotes: [], missing: [] } : await w.trace.quotes(e, verdict);
  const latencyMs = Math.round(performance.now() - t0);
  const outcome = await settle(e, verdict.action, w);
  const decision: Decision = { eventId: e.id, accountId: e.accountId, ts: e.ts, trigger, action: verdict.action, risk: verdict.risk,
    capped: verdict.capped, signalsUsed: verdict.used.map((s) => `${s.eventId}/${s.ruleId}`), rulesApplied: rulesOf(verdict),
    reasoning: verdict.reasoning, quotes, ...(missing.length ? { missingQuotes: missing } : {}), retrievals: w.trace.retrievalsFor(e.id),
    conversationId: w.trace.caseOf(e.accountId), outcome, latencyMs };
  w.record.decisions.push(decision);
  if (decision.action === "ALLOW") {
    return w.trace.ledger(e.ts, ledgerLine(e, `ALLOW reviewed (${trigger}), risk ${verdict.risk.toFixed(2)}`, verdict.used, decision.retrievals));
  }
  await w.trace.flagged({ eventId: e.id, action: decision.action, outcome, reasoning: decision.reasoning, record: decision }, e.accountId);
}

/**
 * One allow-ledger line (PRD C5): UTC time, event, account and kind, what happened, then the signals and each search
 * behind it, with what it returned and which memories it used. The run record holds every search in full.
 */
function ledgerLine(e: TripwireEvent, what: string, signals: RiskSignal[] = [], searches: Retrieval[] = []): string {
  const behind = signals.length ? ` | signals ${signals.map((s) => `${s.ruleId} ${s.score}`).join(", ")}` : "";
  const looked = searches.map((r) => ` | ${searchLine(r)}`).join("");
  return `${e.ts.slice(11, 16)} ${e.id} ${e.accountId} ${e.kind} ${what}${behind}${looked}`;
}

function searchLine(r: Retrieval): string {
  const used = r.usedIds.length ? ` (${r.usedIds.join(" ")})` : "";
  const late = r.timedOut?.length ? `, ${r.timedOut.length} fresh signal(s) still missing` : "";
  return `${r.tool} returned ${r.returnedIds.length}, used ${r.usedIds.length}${used}${late}`;
}

const rulesOf = (v: Verdict) =>
  [...v.used.map((s) => s.ruleId), v.capped ? "policy.travel-cap" : `policy.${v.action.toLowerCase().replace("_", "-")}`];

/** A BLOCK stops. A STEP-UP sends a code to the registered phone; the runner answers for whoever holds it (R3). */
async function settle(e: TripwireEvent, action: Action, w: World): Promise<Outcome> {
  if (action === "ALLOW") return "allowed";
  if (action === "BLOCK") return stop(e, w, "blocked");
  const result: StepUpResultEvent = { id: `${e.id}-otp`, ts: e.ts, accountId: e.accountId, kind: "step_up_result", passed: otpPasses(w.label(e.id)) };
  await w.store.insert(result, w.seq++);
  w.record.stepUps.push(result);
  if (result.passed) return w.locks.verify(e), "passed";
  return stop(e, w, "failed");
}

/** A stopped event never went through: its device is locked out (R2), and history no longer counts it as done. */
async function stop(e: TripwireEvent, w: World, outcome: "blocked" | "failed"): Promise<Outcome> {
  w.locks.stop(e);
  await w.store.markRefused(e.id);
  return outcome;
}

/** Events that never went through: refused after a stop, blocked, or stopped at their step-up. */
function refusedIds(record: RunRecord): Set<string> {
  const stopped = record.decisions.filter((d) => d.outcome === "blocked" || d.outcome === "failed");
  return new Set([...record.denied.map((d) => d.eventId), ...stopped.map((d) => d.eventId)]);
}

/** Keeps the first error: later ones (a close after a failure, say) are consequences. A failed run carries no metrics. */
function fail(record: RunRecord, err: unknown) {
  delete record.metrics;
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

/** The runner answers step-ups from the labels (R3), so every event needs one. */
function labelLookup(labels: Label[], events: TripwireEvent[]): (id: string) => Label {
  const byId = new Map(labels.map((l) => [l.eventId, l]));
  const missing = events.find((e) => !byId.has(e.id));
  if (missing) throw new Error(`event ${missing.id} has no label`);
  return (id) => byId.get(id)!;
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
