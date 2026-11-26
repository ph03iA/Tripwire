import type { AgentName, RiskSignal, SignalType, TripwireEvent } from "../types.js";
import { entitiesOf, WRITE_AT } from "./index.js";
import { type Agent, rupees } from "./types.js";

/**
 * The AI half of a detection agent (M2.5): its model reviews a batch of the events the agent handles and adds signals
 * on top of the rules' (the floor). Everything it sees is measured by code: the events, the rules' readings and the
 * pattern readings. It never sees labels (PRD R3).
 */
export type Prompt = { system: string; user: string; schemaName: string; schema: Record<string, unknown> };
/** A rule's reading on one event, shared (score ≥ WRITE_AT) or not. */
export type Reading = { eventId: string; ruleId: string; score: number; evidence: string };
export type ReviewInput = { agent: Agent; events: TripwireEvent[]; readings: Reading[]; patterns: string[]; recalled?: RiskSignal[] };
/** A signal the model asked to share, after validation. */
export type Proposed = { eventId: string; type: SignalType; score: number; evidence: string };

export const typesOf = (agent: Agent): SignalType[] => [...new Set([...agent.rules, ...agent.contextRules].map((r) => r.type))];

export function reviewPrompt({ agent, events, readings, patterns, recalled = [] }: ReviewInput): Prompt {
  const rules = [...agent.rules, ...agent.contextRules];
  const types = typesOf(agent).map((t) => `- ${t}: ${rules.filter((r) => r.type === t).map((r) => r.when).join("; or ")}`);
  const system = [
    `You are the ${agent.name} agent of Tripwire, which detects account takeovers at a payments app. You review every event you handle, in batches, and share risk signals with the other agents and the decision agent through shared memory.`,
    `- The fixed rules have already shared their own signals: the rule readings marked "shared". Don't repeat them. Add what they miss: a pattern across events or accounts, or an event the rules score too low.`,
    "- The pattern readings measure what your last hour of events share across accounts. One browser, IP address or device failing logins on many accounts, a device or payee shared by unrelated accounts, or a steady machine-like pace are signs of an automated attack. Share a signal on each event that's part of one, and score successful logins and money movements inside it highest.",
    `- Score ${WRITE_AT} when it's worth sharing, 0.7 when strong, 0.9 when near certain. Share nothing when nothing is wrong.`,
    "Signal types you may use (the rule behind each, for reference):",
    ...types,
  ].join("\n");
  const user = [
    `Pattern readings over your last hour of events:\n${patterns.join("\n") || "none"}`,
    ...(recalled.length ? [`Signals other agents shared earlier about these accounts, devices and payees:\n${recalled.map(recalledLine).join("\n")}`] : []),
    `Batch of ${events.length} events, oldest first:\n${events.map(describe).join("\n")}`,
    `Rule readings (event rule score: evidence):\n${readings.map(readingLine).join("\n") || "none"}`,
  ].join("\n\n");
  return { system, user, schemaName: "batch_review", schema: reviewSchema(agent, events) };
}

const readingLine = (r: Reading) => `${r.eventId} ${r.ruleId} ${r.score}${r.score >= WRITE_AT ? " (shared)" : ""}: ${r.evidence}`;
const recalledLine = (s: RiskSignal) => `${s.eventId} ${s.agent} ${s.type} ${s.score} ${s.ts}: ${s.evidence}`;

function reviewSchema(agent: Agent, events: TripwireEvent[]) {
  const signal = {
    type: "object",
    properties: {
      eventId: { type: "string", enum: events.map((e) => e.id) },
      type: { type: "string", enum: typesOf(agent) },
      score: { type: "number" },
      evidence: { type: "string" },
    },
    required: ["eventId", "type", "score", "evidence"],
    additionalProperties: false,
  };
  return { type: "object", properties: { signals: { type: "array", items: signal } }, required: ["signals"], additionalProperties: false };
}

/** One line per event, with what a fraud analyst would look at. */
export function describe(e: TripwireEvent): string {
  const client = "deviceId" in e ? ` | ip ${e.ip} ${e.geo.city},${e.geo.country} device ${e.deviceId} ua "${e.userAgent}"` : "";
  return `${e.id} ${e.ts.slice(0, 19).replace("T", " ")} ${e.accountId} ${e.kind} ${details(e)}${client}`;
}

type Of<K extends TripwireEvent["kind"]> = Extract<TripwireEvent, { kind: K }>;
const DETAILS: { [K in TripwireEvent["kind"]]: (e: Of<K>) => string } = {
  login: (e) => (e.success ? `success via ${e.method}` : `failed (${e.failureReason ?? "unknown"}) via ${e.method}`),
  password_reset: (e) => `via ${e.channel}`,
  account_change: (e) => `${e.field} changed via ${e.channel}`,
  support_contact: (e) => `${e.channel}, intent ${e.intent}, caller ${e.callerPhone} in ${e.callerGeo.city},${e.callerGeo.country}, `
    + `verified by ${e.verification.method}: ${e.verification.passed ? "passed" : "failed"}`,
  transaction: (e) => {
    const payee = e.payeeId ? ` to ${e.payeeId}${e.payeeIsNew ? " (new payee)" : ""}` : "";
    const merchant = e.merchantId ? ` at ${e.merchantId} (${e.merchantCategory ?? "unknown"})` : "";
    return `${e.type} ${rupees(e.amountMinor)} ${e.status}${payee}${merchant}`;
  },
  step_up_result: (e) => `one-time code ${e.passed ? "passed" : "failed"}`,
};
const details = (e: TripwireEvent) => (DETAILS[e.kind] as (e: TripwireEvent) => string)(e);

type Raw = { eventId?: unknown; type?: unknown; score?: unknown; evidence?: unknown };
const isUnit = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;
const isText = (x: unknown) => typeof x === "string" && x.trim() !== "";
const problem = (ok: boolean, text: string) => (ok ? [] : [text]);

/** The signals an answer proposes, and what's wrong with it. An answer with any problem isn't used (the caller retries or keeps the floor). */
export function checkReview(json: unknown, agent: Agent, events: TripwireEvent[]): { proposed: Proposed[]; problems: string[] } {
  const signals = (json as { signals?: unknown } | undefined)?.signals;
  if (!Array.isArray(signals)) return { proposed: [], problems: ["no signals list"] };
  const ids = new Set(events.map((e) => e.id));
  const types = new Set<unknown>(typesOf(agent));
  const problems = (signals as Raw[]).flatMap((s, i) => [
    ...problem(typeof s.eventId === "string" && ids.has(s.eventId), `event ${String(s.eventId)} isn't in the batch`),
    ...problem(types.has(s.type), `type ${String(s.type)} isn't one of the agent's`),
    ...problem(isUnit(s.score), `score ${String(s.score)} isn't between 0 and 1`),
    ...problem(isText(s.evidence), "no evidence"),
  ].map((p) => `signal ${i}: ${p}`));
  return { proposed: problems.length ? [] : (signals as Proposed[]), problems };
}

/** Marks a signal an agent's model added, as opposed to one of its rules. */
export const isAiSignal = (s: RiskSignal) => s.ruleId.endsWith(".ai-review");

/**
 * The floor: the proposals that add to what's already shared. One is kept when it scores WRITE_AT or more and beats
 * every signal already on its event with its type, and it's shared as the agent's own `<agent>.ai-review`. No shared
 * signal is changed, so the model can raise an event's risk but never lower it.
 */
export function aiSignals(agent: AgentName, proposed: Proposed[], events: TripwireEvent[], shared: RiskSignal[]): RiskSignal[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const best = new Map<string, Proposed>();
  for (const p of proposed) {
    const key = `${p.eventId}/${p.type}`;
    if (p.score >= WRITE_AT && p.score > (best.get(key)?.score ?? 0)) best.set(key, p);
  }
  return [...best.values()]
    .filter((p) => !shared.some((s) => s.eventId === p.eventId && s.type === p.type && s.score >= p.score))
    .map((p) => {
      const e = byId.get(p.eventId)!;
      return { agent, ruleId: `${agent}.ai-review`, type: p.type, score: p.score, accountId: e.accountId, eventId: e.id, eventKind: e.kind,
        ts: e.ts, entities: entitiesOf(e), evidence: p.evidence.trim() };
    });
}
