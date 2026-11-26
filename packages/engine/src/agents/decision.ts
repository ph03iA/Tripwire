import type { AccountProfile, RiskSignal, SignalType, TripwireEvent } from "../types.js";
import { noisyOr } from "./index.js";
import { isAiSignal } from "./review.js";
import { hasClient } from "./types.js";

/** PRD C2, written out in knowledge/step-up-policy.md; a test checks that the two agree. */
export const BLOCK_AT = 0.8;
export const STEP_UP_AT = 0.5;
/** A signal this strong gets its event reviewed, whatever the event (PRD C1). */
export const REVIEW_SIGNAL_AT = 0.7;
const REVIEWED_CHARGE_MINOR = 1_000_000; // ₹10,000
const TRAVEL = new Set<SignalType>(["impossible_travel"]);

export type Action = "ALLOW" | "STEP_UP" | "BLOCK";
/** Why the decision agent reviewed an event: it's sensitive, or a signal on it reached REVIEW_SIGNAL_AT. */
export type Trigger = "sensitive" | "signal";
/** Why a BLOCK was lowered to STEP-UP: travel alone on a device in the profile, or risk that only the agents' models put at BLOCK. */
export type Cap = "travel" | "ai";
export type Verdict = {
  action: Action;
  risk: number; // noisy-OR of `used`
  used: RiskSignal[]; // the strongest signal of each type, strongest first
  capped: boolean; // a BLOCK lowered to STEP-UP, for the reason in `cap`
  cap?: Cap;
  reasoning: string;
};

/** C1: every credential or payout change, password reset, transfer and payout, and card charges of ₹10,000 or more. */
export function isSensitive(e: TripwireEvent): boolean {
  if (e.kind === "account_change" || e.kind === "password_reset") return true;
  return e.kind === "transaction" && (e.type !== "card_charge" || e.amountMinor >= REVIEWED_CHARGE_MINOR);
}

/** Whether the event gets a decision, given the signals on it the decision agent can see; null means it's allowed without review. */
export function triggerOf(e: TripwireEvent, signalsOnEvent: RiskSignal[]): Trigger | null {
  if (isSensitive(e)) return "sensitive";
  return signalsOnEvent.some((s) => s.score >= REVIEW_SIGNAL_AT) ? "signal" : null;
}

/** The one-line reason in the allow ledger for an event the decision agent didn't review (C1). */
export const UNREVIEWED = `not reviewed: not a sensitive event, and no signal of ${REVIEW_SIGNAL_AT} or more`;

/**
 * C2: risk is the noisy-OR of the strongest signal of each type among the signals the decision agent sees for the
 * event (the caller has already kept only same-entity signals from the last 72 hours). ≥ BLOCK_AT blocks, ≥ STEP_UP_AT
 * steps up, anything lower is allowed; travel alone on a device in the profile never blocks. Pure: no time, no I/O.
 */
export function decide(e: TripwireEvent, signals: RiskSignal[], profile: AccountProfile | undefined): Verdict {
  const used = strongestPerType(signals);
  const risk = noisyOr(used.map((s) => s.score));
  const cap = actionFor(risk) === "BLOCK" ? capOf(e, signals, used, profile) : undefined;
  const action = cap ? "STEP_UP" : actionFor(risk);
  return { action, risk, used, capped: cap !== undefined, ...(cap ? { cap } : {}), reasoning: reasoningFor(e, action, risk, used, cap) };
}

/**
 * Travel alone on a device in the profile never blocks (C2). Nor does risk that reaches BLOCK only through signals the
 * agents' models added (M2.5): a block needs the rules' own evidence, while a step-up still stops an attacker (R3).
 */
function capOf(e: TripwireEvent, signals: RiskSignal[], used: RiskSignal[], profile: AccountProfile | undefined): Cap | undefined {
  if (isKnownDeviceTravel(e, used, profile)) return "travel";
  const rulesRisk = noisyOr(strongestPerType(signals.filter((s) => !isAiSignal(s))).map((s) => s.score));
  return rulesRisk < BLOCK_AT ? "ai" : undefined;
}

const actionFor = (risk: number): Action => (risk >= BLOCK_AT ? "BLOCK" : risk >= STEP_UP_AT ? "STEP_UP" : "ALLOW");

/** Ties go to the newer signal, then the earlier event ID, so the input order never changes the result. */
function strongestPerType(signals: RiskSignal[]): RiskSignal[] {
  const best = new Map<SignalType, RiskSignal>();
  for (const s of signals) {
    const held = best.get(s.type);
    if (!held || stronger(s, held)) best.set(s.type, s);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
}

const stronger = (a: RiskSignal, b: RiskSignal) =>
  a.score !== b.score ? a.score > b.score : a.ts !== b.ts ? a.ts > b.ts : a.eventId < b.eventId;

function isKnownDeviceTravel(e: TripwireEvent, used: RiskSignal[], profile: AccountProfile | undefined): boolean {
  if (!hasClient(e) || !used.every((s) => TRAVEL.has(s.type))) return false;
  return profile?.knownDevices.some((d) => d.id === e.deviceId) ?? false;
}

const POLICY: Record<Action, string> = {
  BLOCK: `risk of ${BLOCK_AT} or more is blocked`,
  STEP_UP: `risk from ${STEP_UP_AT} up to ${BLOCK_AT} gets a one-time code to the registered phone`,
  ALLOW: `risk under ${STEP_UP_AT} is allowed`,
};
const LABEL: Record<Action, string> = { BLOCK: "BLOCK", STEP_UP: "STEP-UP", ALLOW: "ALLOW" };

/** The plain-English "why": a template over the verdict, so nothing in it is generated text. */
const CAP_REASON: Record<Cap, string> = {
  travel: " The only risk is travel, on a device in the account's profile, so it's capped at STEP-UP.",
  ai: " Only the agents' models put it at BLOCK level, so it's capped at STEP-UP: a block needs the rules' own evidence.",
};

function reasoningFor(e: TripwireEvent, action: Action, risk: number, used: RiskSignal[], cap: Cap | undefined): string {
  if (used.length === 0) return `${LABEL[action]}: no risk signals visible for the account, its device, IP or payee in the last 72 hours.`;
  const parts = used.map((s) => `${s.type} ${s.score}${s.accountId === e.accountId ? "" : ` on ${s.accountId}`} (${s.ruleId}: ${s.evidence})`);
  return `${LABEL[action]}: risk ${risk.toFixed(2)} from ${parts.join("; ")}. Policy: ${POLICY[cap ? "BLOCK" : action]}.${cap ? CAP_REASON[cap] : ""}`;
}
