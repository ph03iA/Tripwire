import type { Action } from "../agents/decision.js";
import { AGENTS, WRITE_AT } from "../agents/index.js";
import { checkJudgment, judgmentPrompt, keyOf, type Knowledge } from "../agents/judgment.js";
import { patternReadings, patternWindow } from "../agents/readings.js";
import { checkReview, type Prompt, type Reading, reviewPrompt } from "../agents/review.js";
import type { Agent } from "../agents/types.js";
import { generate } from "../generator/generate.js";
import { localKnowledge } from "../runner/decider.js";
import { browserShares, type Decision, replayStream, type RunRecord, type Stream } from "../runner/replay.js";
import type { AccountProfile, AgentName, Label, RiskSignal, TripwireEvent } from "../types.js";

/**
 * The calls `npm run llm-check` sends to every candidate model, built from a seed-42 OFF run: the detection agents'
 * batch reviews and the decision agent's judgments, with the agents' own prompts. Labels are used only to score the
 * answers, never in a prompt (PRD R3).
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
export { keyOf };

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

export const promptFor = (s: Sample, knowledge: Knowledge = localKnowledge()): Prompt =>
  (s.kind === "batch" ? reviewPrompt({ agent: s.agent, events: s.events, readings: s.readings, patterns: s.patterns })
    : judgmentPrompt({ event: s.event, signals: s.signals, profile: s.profile }, knowledge));

/** The events a batch answer flags (score ≥ WRITE_AT), and what's wrong with it. */
export function checkBatch(json: unknown, { agent, events }: BatchSample): { flagged: string[]; problems: string[] } {
  const { proposed, problems } = checkReview(json, agent, events);
  return { flagged: [...new Set(proposed.filter((s) => s.score >= WRITE_AT).map((s) => s.eventId))], problems };
}

/** A decision answer's action, and what's wrong with it: the checks the decision agent runs before using an answer. */
export function checkDecision(json: unknown, { signals }: DecisionSample): { action: Action | undefined; problems: string[] } {
  const { judgment, problems } = checkJudgment(json, signals);
  return { action: judgment?.action, problems };
}

export const agentOf = (s: Sample): AgentName | "decision" => (s.kind === "batch" ? s.agent.name : "decision");
