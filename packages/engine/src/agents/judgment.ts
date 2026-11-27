import type { AccountProfile, RiskSignal, TripwireEvent } from "../types.js";
import { type Action, CAP_REASON, capFor, type Verdict } from "./decision.js";
import { describe, type Prompt } from "./review.js";

/**
 * The AI half of the decision agent (M2.5 step 3): its model weighs the signals it may see against the step-up policy
 * and the playbooks, and answers in strict JSON. Code checks the answer and applies the guardrails, so the model's
 * judgment stays inside the policy. It never sees labels (PRD R3).
 */
export type Judgment = { action: Action; risk: number; cites: string[]; reasoning: string; needMore: string };
export type JudgmentInput = { event: TripwireEvent; signals: RiskSignal[]; profile: AccountProfile | undefined; asked?: { entity: string } };
/** The policy and playbooks, the same documents uploaded to the knowledge base. */
export type Knowledge = { policy: string; playbooks: string[] };

export const keyOf = (s: RiskSignal) => `${s.eventId}/${s.ruleId}`;
const ACTIONS = ["ALLOW", "STEP_UP", "BLOCK"] as const;
const ENTITY = /^(ip|device|payee):(\S+)$/;
const ENTITY_FIELD = { ip: "ip", device: "deviceId", payee: "payeeId" } as const;

export function judgmentPrompt({ event, signals, profile, asked }: JudgmentInput, knowledge: Knowledge): Prompt {
  const system = [
    "You are the decision agent of Tripwire, which detects account takeovers at a payments app. For a sensitive or flagged event, choose ALLOW, STEP_UP (a one-time code to the registered phone) or BLOCK, from the risk signals the detection agents shared.",
    "- Cite the signals you rely on by their keys, and only keys you were given. STEP_UP and BLOCK must cite at least one.",
    "- Signals whose rule ends in .ai-review come from the agents' models; the others come from fixed rules.",
    "- risk: your estimate, from 0 to 1, that the account is being taken over.",
    "- reasoning: one or two plain sentences a fraud analyst can check.",
    asked ? "- need_more: an empty string; you've had your one search." : "- need_more: if the signals aren't enough to decide, one entity to search shared memory for (ip:<address>, device:<id> or payee:<id>), and you'll be asked again with what it finds; otherwise an empty string.",
    "",
    knowledge.policy,
    ...knowledge.playbooks,
  ].join("\n");
  const lines = signals.map((s) => `${keyOf(s)} | ${s.agent} | ${s.type} | ${s.score} | ${s.ts}: ${s.evidence}`);
  const found = asked ? [`You asked shared memory for ${asked.entity}; what it found is among the signals above.`] : [];
  const user = [`Event: ${describe(event)}`, accountLine(event, profile), `Signals (key | agent | type | score | when: evidence):\n${lines.join("\n")}`, ...found].join("\n");
  const schema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS },
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

type Raw = { action?: unknown; risk?: unknown; cites?: unknown; reasoning?: unknown; need_more?: unknown };
const isUnit = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;
const problem = (ok: boolean, text: string) => (ok ? [] : [text]);

/** The answer as a judgment, or what's wrong with it: the guardrails a model can break by answering badly. */
export function checkJudgment(json: unknown, signals: RiskSignal[]): { judgment?: Judgment; problems: string[] } {
  const a = (json ?? {}) as Raw;
  const keys = new Set(signals.map(keyOf));
  const cites: unknown[] = Array.isArray(a.cites) ? a.cites : [];
  const stops = a.action === "STEP_UP" || a.action === "BLOCK";
  const problems = [
    ...problem((ACTIONS as readonly unknown[]).includes(a.action), `action ${String(a.action)} isn't ALLOW, STEP_UP or BLOCK`),
    ...problem(isUnit(a.risk), `risk ${String(a.risk)} isn't between 0 and 1`),
    ...problem(Array.isArray(a.cites), "no cites list"),
    ...cites.filter((c) => !keys.has(c as string)).map((c) => `cites ${String(c)}, which it wasn't given`),
    ...problem(!stops || cites.length > 0, `${String(a.action)} cites no signal`),
    ...problem(typeof a.reasoning === "string" && a.reasoning.trim() !== "", "no reasoning"),
    ...problem(a.need_more === "" || ENTITY.test(String(a.need_more)), `need_more ${String(a.need_more)} isn't an entity`),
  ];
  if (problems.length) return { problems };
  return { judgment: { action: a.action as Action, risk: a.risk as number, cites: cites as string[], reasoning: (a.reasoning as string).trim(),
    needMore: a.need_more as string }, problems };
}

/** The signals a need_more entity names: the same entity in a signal's device, IP address or payee. */
export function namesEntity(entity: string): ((s: RiskSignal) => boolean) | undefined {
  const m = ENTITY.exec(entity);
  if (!m) return undefined;
  const field = ENTITY_FIELD[m[1] as keyof typeof ENTITY_FIELD];
  return (s) => s.entities[field] === m[2];
}

/**
 * The guardrails code applies to a valid judgment, the same caps the rules obey: travel alone on a device in the
 * profile never blocks (C2), and a BLOCK needs the rules' own evidence, so one that only the models' signals reach is a
 * STEP-UP (which still stops an attacker). The verdict uses the cited signals, the model's risk and its reasoning.
 */
export function guarded(j: Judgment, e: TripwireEvent, signals: RiskSignal[], profile: AccountProfile | undefined): Verdict {
  const used = j.cites.map((key) => signals.find((s) => keyOf(s) === key)!);
  const cap = j.action === "BLOCK" ? capFor(e, signals, used, profile) : undefined;
  return { action: cap ? "STEP_UP" : j.action, risk: j.risk, used, capped: cap !== undefined, ...(cap && { cap }),
    reasoning: `${j.reasoning}${cap ? CAP_REASON[cap] : ""}` };
}

