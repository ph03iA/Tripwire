import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../agents/decision.js";
import { AGENTS, WRITE_AT } from "../agents/index.js";
import { patternReadings, patternWindow } from "../agents/readings.js";
import { checkReview, describe, type Prompt, type Reading, reviewPrompt } from "../agents/review.js";
import type { Agent } from "../agents/types.js";
import { generate } from "../generator/generate.js";
import { KNOWLEDGE_DIR, POLICY_FILE } from "../knowledge/upload.js";
import { browserShares, type Decision, replayStream, type RunRecord, type Stream } from "../runner/replay.js";
import type { AccountProfile, AgentName, Label, RiskSignal, TripwireEvent } from "../types.js";

/**
 * The calls `npm run llm-check` sends to every candidate model, built from a seed-42 OFF run: the detection agents'
 * own batch-review prompts, and draft decision prompts until step 3 moves them into the decision agent. Labels are
 * used only to score the answers, never in a prompt (PRD R3).
 */
const BATCH = 50;
const LEGIT_DECISIONS = 3;

export type BatchSample = {
  kind: "batch"; id: string; agent: Agent; events: TripwireEvent[]; readings: Reading[]; patterns: string[]; attacks: string[]; ruleFlags: string[];
};
export type DecisionSample = {
  kind: "decision"; id: string; event: TripwireEvent; signals: RiskSignal[]; profile: AccountProfile | undefined;
  attack: boolean; chain: string | undefined; rulesAction: Action;
};
export type Sample = BatchSample | DecisionSample;
export type { Prompt };

export async function samples(seed = 42): Promise<Sample[]> {
  const stream: Stream = { seed, ...generate(seed) };
  const run = await replayStream(stream);
  const label = new Map(stream.labels.map((l) => [l.eventId, l]));
  const uaShare = browserShares(stream.accounts);
  const batches = AGENTS.map((a) => batchSample(a, stream.events, run, label, uaShare)).filter((b) => b.attacks.length > 0);
  return [...batches, ...decisionSamples(run, stream, label)];
}

/** The window of BATCH events the agent handles with the most attack events in it: the hardest test of what it shares. */
function batchSample(agent: Agent, events: TripwireEvent[], run: RunRecord, label: Map<string, Label>, uaShare: (ua: string) => number): BatchSample {
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
    patterns: patternReadings(patternWindow(window, handled.slice(0, start)), uaShare),
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

export const promptFor = (s: Sample): Prompt =>
  (s.kind === "batch" ? reviewPrompt({ agent: s.agent, events: s.events, readings: s.readings, patterns: s.patterns }) : decisionPrompt(s));

/** The events a batch answer flags (score ≥ WRITE_AT), and what's wrong with it. */
export function checkBatch(json: unknown, { agent, events }: BatchSample): { flagged: string[]; problems: string[] } {
  const { proposed, problems } = checkReview(json, agent, events);
  return { flagged: [...new Set(proposed.filter((s) => s.score >= WRITE_AT).map((s) => s.eventId))], problems };
}

type Answer = { action?: unknown; risk?: unknown; cites?: unknown; reasoning?: unknown; need_more?: unknown };
const ACTIONS = new Set<unknown>(["ALLOW", "STEP_UP", "BLOCK"]);
const ENTITY = /^(ip|device|payee):\S+$/;
const isUnit = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;
const isText = (x: unknown) => typeof x === "string" && x.trim() !== "";
const problem = (ok: boolean, text: string) => (ok ? [] : [text]);

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
