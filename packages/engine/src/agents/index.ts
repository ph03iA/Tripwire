import type { AgentName, RiskSignal, TripwireEvent } from "../types.js";
import { deviceAgent } from "./device.js";
import { loginAgent } from "./login.js";
import { supportAgent } from "./support.js";
import { txnAgent } from "./txn.js";
import type { Agent, AgentContext, ContextRule, Finding, Rule } from "./types.js";

/** An agent recalls shared signals once its own findings combine to this (PRD A6). */
export const RECALL_AT = 0.2;
/** Findings at or above this become signals the other agents can see (PRD A5). */
export const WRITE_AT = 0.4;

export const AGENTS: Agent[] = [loginAgent, deviceAgent, txnAgent, supportAgent];

/** Who owns each event type. In OFF mode a decision sees only the owner's signals (PRD R4). */
export const OWNER: Record<TripwireEvent["kind"], AgentName | null> = {
  login: "login",
  password_reset: "login",
  transaction: "txn",
  support_contact: "support",
  account_change: "support",
  step_up_result: null,
};

/** The agents that see an event: its owner, plus the device agent when it has client fields. */
export const agentsFor = (e: TripwireEvent) => AGENTS.filter((a) => a.handles(e));

/** Combines independent risk scores: 1 − Π(1 − s). Rounded, because in floating point a lone 0.2 comes out as 0.19999… */
export const noisyOr = (scores: number[]) => Math.round((1 - scores.reduce((p, s) => p * (1 - s), 1)) * 1e6) / 1e6;

/** Signals an agent can see for an event: its own in OFF mode, everyone's in ON mode. */
export type Recall = (agent: AgentName, e: TripwireEvent) => Promise<RiskSignal[]>;

/** One agent, one event: the base rules, then, if they look risky enough, recall and the context rules. */
export async function detect(agent: Agent, e: TripwireEvent, ctx: AgentContext, recall: Recall): Promise<Finding[]> {
  const findings = await runRules(agent.rules, e, ctx);
  if (noisyOr(findings.map((f) => f.score)) < RECALL_AT) return findings;
  return [...findings, ...runContextRules(agent.contextRules, e, await recall(agent.name, e))];
}

async function runRules(rules: Rule[], e: TripwireEvent, ctx: AgentContext): Promise<Finding[]> {
  const hits = await Promise.all(rules.map((r) => r.fire(e, ctx)));
  return rules.flatMap((r, i) => {
    const hit = hits[i];
    return hit ? [{ ruleId: r.id, type: r.type, ...hit }] : [];
  });
}

function runContextRules(rules: ContextRule[], e: TripwireEvent, recalled: RiskSignal[]): Finding[] {
  return rules.flatMap((r) => {
    const hit = r.fire(e, recalled);
    return hit ? [{ ruleId: r.id, type: r.type, ...hit }] : [];
  });
}

/** Turns the findings worth sharing into signals, carrying the entities other agents search by. */
export function toSignals(agent: AgentName, e: TripwireEvent, findings: Finding[]): RiskSignal[] {
  const entities = entitiesOf(e);
  return findings
    .filter((f) => f.score >= WRITE_AT)
    .map((f) => ({ agent, ruleId: f.ruleId, type: f.type, score: f.score, accountId: e.accountId, eventId: e.id, eventKind: e.kind, ts: e.ts,
      entities, evidence: f.evidence }));
}

/** The entities an event names, which signals carry and recall searches by. */
export function entitiesOf(e: TripwireEvent): RiskSignal["entities"] {
  if (e.kind === "transaction") return { ip: e.ip, deviceId: e.deviceId, payeeId: e.payeeId, merchantId: e.merchantId };
  return "deviceId" in e ? { ip: e.ip, deviceId: e.deviceId } : {};
}
