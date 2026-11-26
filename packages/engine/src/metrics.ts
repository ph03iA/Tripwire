import { isSensitive } from "./agents/decision.js";
import { rupees } from "./agents/types.js";
import type { Label, TripwireEvent } from "./types.js";

/** What scoring needs from a run: what the decision agent did, and which events never went through. */
export type Scored = { decisions: { eventId: string; action: string }[]; refused: Set<string> };

export type ChainResult = {
  chainId: string;
  takeoverPhase: number;
  prevented: boolean; // the takeover event never executed, so the money never left
  stoppedAt: number | null; // phase of the chain's first refused event, when prevented
  stepsEarly: number | null; // takeoverPhase − stoppedAt: 0 means the payment itself was refused
  takeoverMinor: number;
};

export type Metrics = {
  chains: ChainResult[];
  prevented: number;
  caughtEarly: number; // prevented at least one phase before the takeover
  avgStepsEarly: number | null; // over prevented chains
  lossPreventedMinor: number;
  lossAtRiskMinor: number;
  legitSensitive: number; // legit sensitive events: the denominator for the two rates below
  legitSensitiveBlocks: number; // false positives (PRD §8): BLOCKs on those events
  legitSensitiveStepUps: number; // friction: STEP-UPs on those events
  legitBlocks: number; // BLOCKs on any legit event, a login with a strong signal included
  legitStepUps: number; // STEP-UPs on any legit event
  legitRefused: number; // legit events refused after a stop, their own decision included
};

/**
 * Scores a run against the labels (PRD §8). Prevention is measured, not assumed: it comes from which events the
 * runner refused, never from a decision's intent. Only the runner and this file read labels.
 */
export function scoreRun(run: Scored, events: TripwireEvent[], labels: Label[]): Metrics {
  const byId = new Map(events.map((e) => [e.id, e]));
  const chains = chainResults(labels, byId, run.refused);
  const prevented = chains.filter((c) => c.prevented);
  const legit = new Set(labels.filter((l) => !l.attack).map((l) => l.eventId));
  const legitDecisions = run.decisions.filter((d) => legit.has(d.eventId));
  const sensitiveDecisions = legitDecisions.filter((d) => isSensitive(byId.get(d.eventId)!));
  const count = (decisions: Scored["decisions"], action: string) => decisions.filter((d) => d.action === action).length;
  return {
    chains,
    prevented: prevented.length,
    caughtEarly: prevented.filter((c) => (c.stepsEarly ?? 0) >= 1).length,
    avgStepsEarly: prevented.length ? prevented.reduce((n, c) => n + (c.stepsEarly ?? 0), 0) / prevented.length : null,
    lossPreventedMinor: prevented.reduce((n, c) => n + c.takeoverMinor, 0),
    lossAtRiskMinor: chains.reduce((n, c) => n + c.takeoverMinor, 0),
    legitSensitive: [...legit].filter((id) => isSensitive(byId.get(id)!)).length,
    legitSensitiveBlocks: count(sensitiveDecisions, "BLOCK"),
    legitSensitiveStepUps: count(sensitiveDecisions, "STEP_UP"),
    legitBlocks: count(legitDecisions, "BLOCK"),
    legitStepUps: count(legitDecisions, "STEP_UP"),
    legitRefused: [...run.refused].filter((id) => legit.has(id)).length,
  };
}

/** One result per victim chain, in the order the chains start. Probes aren't chains: stopping them earns nothing. */
function chainResults(labels: Label[], byId: Map<string, TripwireEvent>, refused: Set<string>): ChainResult[] {
  const steps = new Map<string, Label[]>();
  for (const l of labels) {
    if (l.role === "victim" && l.chainId) steps.set(l.chainId, [...(steps.get(l.chainId) ?? []), l]);
  }
  return [...steps].map(([chainId, chain]) => {
    const takeover = chain.find((l) => l.takeoverStep);
    if (!takeover?.step) throw new Error(`chain ${chainId} has no takeover step`);
    const prevented = refused.has(takeover.eventId);
    const stoppedAt = prevented ? chain.find((l) => refused.has(l.eventId))!.step! : null;
    const amount = byId.get(takeover.eventId);
    return { chainId, takeoverPhase: takeover.step, prevented, stoppedAt, stepsEarly: stoppedAt === null ? null : takeover.step - stoppedAt,
      takeoverMinor: amount?.kind === "transaction" ? amount.amountMinor : 0 };
  });
}

const percent = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : "–");

/** The per-chain table and the summary, for the CLI. */
export function formatMetrics(m: Metrics): string {
  const rows = m.chains.map((c) =>
    `  ${c.chainId.padEnd(6)} ${String(c.takeoverPhase).padEnd(9)} ${String(c.stoppedAt ?? "–").padEnd(11)} ${c.stepsEarly ?? "–"}`);
  return [
    "  chain  takeover  stopped at  steps early",
    ...rows,
    `prevented ${m.prevented} of ${m.chains.length}, caught early ${m.caughtEarly}, avg steps early ${m.avgStepsEarly?.toFixed(2) ?? "–"}`,
    `loss prevented ${rupees(m.lossPreventedMinor)} of ${rupees(m.lossAtRiskMinor)}`,
    `legit sensitive events ${m.legitSensitive}: BLOCK ${m.legitSensitiveBlocks} (${percent(m.legitSensitiveBlocks, m.legitSensitive)}), `
      + `STEP-UP ${m.legitSensitiveStepUps} (${percent(m.legitSensitiveStepUps, m.legitSensitive)})`,
    `all legit events: BLOCK ${m.legitBlocks}, STEP-UP ${m.legitStepUps}; refused after a stop ${m.legitRefused}`,
  ].join("\n");
}
