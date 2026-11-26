import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../agents/decision.js";
import { AGENTS } from "../agents/index.js";
import { type Agent, rupees } from "../agents/types.js";
import { generate } from "../generator/generate.js";
import { KNOWLEDGE_DIR, POLICY_FILE } from "../knowledge/upload.js";
import { type Decision, replayStream, type RunFinding, type RunRecord, type Stream } from "../runner/replay.js";
import type { AccountProfile, AgentName, Label, RiskSignal, TripwireEvent } from "../types.js";
import type { JsonSchema } from "./client.js";

/**
 * The calls `npm run llm-check` sends to every candidate model, built from a seed-42 OFF run: batch reviews for the
 * detection agents and decisions on triggers with evidence. The prompts are drafts; steps 2 and 3 of the M2.5 plan
 * move them into the agents. Labels are used only to score the answers, never in a prompt (PRD R3).
 */
const BATCH = 50;
const LEGIT_DECISIONS = 3;
const SHARE_AT = 0.4; // a signal worth sharing, as the agents' WRITE_AT

export type BatchSample = { kind: "batch"; id: string; agent: Agent; events: TripwireEvent[]; readings: RunFinding[]; attacks: string[]; ruleFlags: string[] };
export type DecisionSample = {
  kind: "decision"; id: string; event: TripwireEvent; signals: RiskSignal[]; profile: AccountProfile | undefined;
  attack: boolean; chain: string | undefined; rulesAction: Action;
};
export type Sample = BatchSample | DecisionSample;
export type Prompt = { system: string; user: string; schemaName: string; schema: JsonSchema };

export async function samples(seed = 42): Promise<Sample[]> {
  const stream: Stream = { seed, ...generate(seed) };
  const run = await replayStream(stream);
  const label = new Map(stream.labels.map((l) => [l.eventId, l]));
  const batches = AGENTS.map((a) => batchSample(a, stream.events, run, label)).filter((b) => b.attacks.length > 0);
  return [...batches, ...decisionSamples(run, stream, label)];
}

/** The window of BATCH events the agent handles with the most attack events in it: the hardest test of what it shares. */
function batchSample(agent: Agent, events: TripwireEvent[], run: RunRecord, label: Map<string, Label>): BatchSample {
  const handled = events.filter((e) => agent.handles(e));
  const isAttack = (e: TripwireEvent) => label.get(e.id)?.attack === true;
  let best = 0;
  let start = 0;
  for (let i = 0; i + BATCH <= handled.length; i++) {
    const n = handled.slice(i, i + BATCH).filter(isAttack).length;
    if (n > best) [best, start] = [n, i];
  }
  const window = handled.slice(start, start + BATCH);
  const ids = new Set(window.map((e) => e.id));
  return {
    kind: "batch", id: `batch:${agent.name}`, agent, events: window,
    readings: run.findings.filter((f) => f.agent === agent.name && ids.has(f.eventId)),
    attacks: window.filter(isAttack).map((e) => e.id),
    ruleFlags: [...new Set(run.signals.filter((s) => s.agent === agent.name && ids.has(s.eventId)).map((s) => s.eventId))],
  };
}

/** The first decision with evidence in each attack chain, and the strongest legit ones, one per rule. */
function decisionSamples(run: RunRecord, stream: Stream, label: Map<string, Label>): DecisionSample[] {
  const withEvidence = run.decisions.filter((d) => d.signalsUsed.length > 0);
  const firstPerChain = new Map<string, Decision>();
  for (const d of withEvidence) {
    const chain = label.get(d.eventId)?.chainId;
    if (label.get(d.eventId)?.attack && chain && !firstPerChain.has(chain)) firstPerChain.set(chain, d);
  }
  const legit: Decision[] = [];
  const strongestFirst = withEvidence.filter((d) => !label.get(d.eventId)?.attack).sort((a, b) => b.risk - a.risk || a.eventId.localeCompare(b.eventId));
  for (const d of strongestFirst) {
    if (legit.length < LEGIT_DECISIONS && !legit.some((x) => ruleOf(x) === ruleOf(d))) legit.push(d);
  }
  const events = new Map(stream.events.map((e) => [e.id, e]));
  return [...firstPerChain.values(), ...legit].map((d) => ({
    kind: "decision", id: `decision:${d.eventId}`, event: events.get(d.eventId)!,
    signals: run.signals.filter((s) => d.signalsUsed.includes(keyOf(s))),
    profile: stream.accounts.find((a) => a.id === d.accountId),
    attack: label.get(d.eventId)?.attack === true, chain: label.get(d.eventId)?.chainId, rulesAction: d.action,
  }));
}

const ruleOf = (d: Decision) => d.signalsUsed[0]!.split("/")[1]!;
export const keyOf = (s: RiskSignal) => `${s.eventId}/${s.ruleId}`;

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

const typesOf = (agent: Agent) => [...new Set([...agent.rules, ...agent.contextRules].map((r) => r.type))];

export function batchPrompt({ agent, events, readings }: BatchSample): Prompt {
  const rules = [...agent.rules, ...agent.contextRules];
  const types = typesOf(agent).map((t) => `- ${t}: ${rules.filter((r) => r.type === t).map((r) => r.when).join("; or ")}`);
  const system = [
    `You are the ${agent.name} agent of Tripwire, which detects account takeovers at a payments app. You read every event you handle, in batches, and share risk signals with the other agents and the decision agent.`,
    "- Rule readings are measurements from fixed checks. Use them as evidence, not verdicts: a reading can be noise, and an event without one can still be risky.",
    "- Look across the whole batch: the same device, IP address or browser on many accounts, a steady rhythm, a burst of failures, money moving soon after a change.",
    `- Share a signal only for takeover risk you can state in one sentence. Score ${SHARE_AT} when it's worth sharing, 0.7 when strong, 0.9 when near certain. Sharing nothing is a fine answer.`,
    "Signal types you may use (the rule behind each, for reference):",
    ...types,
  ].join("\n");
  const lines = readings.map((f) => `${f.eventId} ${f.ruleId} ${f.score}: ${f.evidence}`);
  const user = `Batch of ${events.length} events, oldest first:\n${events.map(describe).join("\n")}\n\nRule readings (event rule score: evidence):\n${lines.join("\n") || "none"}`;
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
  const schema = { type: "object", properties: { signals: { type: "array", items: signal } }, required: ["signals"], additionalProperties: false };
  return { system, user, schemaName: "batch_review", schema };
}

export function decisionPrompt({ event, signals, profile }: DecisionSample, policy = readFileSync(join(KNOWLEDGE_DIR, POLICY_FILE), "utf8")): Prompt {
  const system = [
    "You are the decision agent of Tripwire, which detects account takeovers at a payments app. For a sensitive or flagged event, choose ALLOW, STEP_UP (a one-time code to the registered phone) or BLOCK, from the risk signals the detection agents shared.",
    "- Cite the signals you rely on by their keys, and only keys you were given. STEP_UP and BLOCK must cite at least one.",
    "- risk: your estimate, from 0 to 1, that the account is being taken over.",
    "- reasoning: one or two plain sentences a fraud analyst can check.",
    "- need_more: if the signals aren't enough to decide, one entity to search shared memory for (ip:<address>, device:<id> or payee:<id>); otherwise an empty string.",
    "",
    policy,
  ].join("\n");
  const lines = signals.map((s) => `${keyOf(s)} | ${s.agent} | ${s.type} | ${s.score} | ${s.ts}: ${s.evidence}`);
  const user = `Event: ${describe(event)}\n${accountLine(event, profile)}\nSignals (key | agent | type | score | when: evidence):\n${lines.join("\n")}`;
  const schema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["ALLOW", "STEP_UP", "BLOCK"] },
      risk: { type: "number" },
      cites: { type: "array", items: { type: "string", enum: signals.map(keyOf) } },
      reasoning: { type: "string" },
      need_more: { type: "string" },
    },
    required: ["action", "risk", "cites", "reasoning", "need_more"],
    additionalProperties: false,
  };
  return { system, user, schemaName: "decision", schema };
}

function accountLine(e: TripwireEvent, profile: AccountProfile | undefined): string {
  if (!profile) return `Account ${e.accountId}: no profile.`;
  const device = "deviceId" in e ? `, and this device is ${profile.knownDevices.some((d) => d.id === e.deviceId) ? "known" : "new"}` : "";
  const payee = e.kind === "transaction" && e.payeeId ? `, and this payee is ${profile.knownPayees.includes(e.payeeId) ? "known" : "new"}` : "";
  return `Account ${e.accountId}: home ${profile.home.city},${profile.home.country}; ${profile.knownDevices.length} known devices${device}; ${profile.knownPayees.length} known payees${payee}.`;
}

export const promptFor = (s: Sample): Prompt => (s.kind === "batch" ? batchPrompt(s) : decisionPrompt(s));

type Shared = { eventId?: unknown; type?: unknown; score?: unknown; evidence?: unknown };

/** What a batch answer shares, and what's wrong with it: the checks steps 2 and 3 run before using an answer. */
export function checkBatch(json: unknown, { agent, events }: BatchSample): { flagged: string[]; problems: string[] } {
  const signals = (json as { signals?: unknown } | undefined)?.signals;
  if (!Array.isArray(signals)) return { flagged: [], problems: ["no signals list"] };
  const ids = new Set(events.map((e) => e.id));
  const types = new Set<unknown>(typesOf(agent));
  const problems = (signals as Shared[]).flatMap((s, i) => signalProblems(s, ids, types).map((p) => `signal ${i}: ${p}`));
  const flagged = (signals as Shared[]).filter((s) => typeof s.score === "number" && s.score >= SHARE_AT).map((s) => String(s.eventId));
  return { flagged: [...new Set(flagged)], problems };
}

const isUnit = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;
const isText = (x: unknown) => typeof x === "string" && x.trim() !== "";
const problem = (ok: boolean, text: string) => (ok ? [] : [text]);

function signalProblems(s: Shared, ids: Set<string>, types: Set<unknown>): string[] {
  return [
    ...problem(typeof s.eventId === "string" && ids.has(s.eventId), `event ${String(s.eventId)} isn't in the batch`),
    ...problem(types.has(s.type), `type ${String(s.type)} isn't one of the agent's`),
    ...problem(isUnit(s.score), `score ${String(s.score)} isn't between 0 and 1`),
    ...problem(isText(s.evidence), "no evidence"),
  ];
}

type Answer = { action?: unknown; risk?: unknown; cites?: unknown; reasoning?: unknown; need_more?: unknown };
const ACTIONS = new Set<unknown>(["ALLOW", "STEP_UP", "BLOCK"]);
const ENTITY = /^(ip|device|payee):\S+$/;

/** A decision answer's action, and what's wrong with it: the guardrails of step 3, checked here on the drafts. */
export function checkDecision(json: unknown, { signals }: DecisionSample): { action: Action | undefined; problems: string[] } {
  const a = (json ?? {}) as Answer;
  const keys = new Set(signals.map(keyOf));
  const cites: unknown[] = Array.isArray(a.cites) ? a.cites : [];
  const stops = a.action === "STEP_UP" || a.action === "BLOCK";
  const problems = [
    ...problem(ACTIONS.has(a.action), `action ${String(a.action)} isn't ALLOW, STEP_UP or BLOCK`),
    ...problem(isUnit(a.risk), `risk ${String(a.risk)} isn't between 0 and 1`),
    ...problem(Array.isArray(a.cites), "no cites list"),
    ...cites.filter((c) => !keys.has(c as string)).map((c) => `cites ${String(c)}, which it wasn't given`),
    ...problem(!stops || cites.length > 0, `${String(a.action)} cites no signal`),
    ...problem(isText(a.reasoning), "no reasoning"),
    ...problem(a.need_more === "" || ENTITY.test(String(a.need_more)), `need_more ${String(a.need_more)} isn't an entity`),
  ];
  return { action: ACTIONS.has(a.action) ? (a.action as Action) : undefined, problems };
}

export const agentOf = (s: Sample): AgentName | "decision" => (s.kind === "batch" ? s.agent.name : "decision");
