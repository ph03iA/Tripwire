import { fileURLToPath } from "node:url";
import { AGENTS, RECALL_AT, WRITE_AT } from "../agents/index.js";
import type { Agent } from "../agents/types.js";

export const RISK_RULES_PATH = fileURLToPath(new URL("../../../../knowledge/risk-rules.md", import.meta.url));

const TITLES: Record<Agent["name"], string> = { login: "Login", device: "Device", txn: "Transaction", support: "Support" };

/** knowledge/risk-rules.md, generated from the agents' rules so the code and the knowledge base can't drift (PRD A5). */
export function renderRiskRules(): string {
  const header = [
    "# Risk rules",
    "",
    "Generated from `packages/engine/src/agents` by `npm run knowledge`. Don't edit by hand: a test fails when this file and the code disagree.",
    "",
    `Each rule scores one event from 0 to 1 (the score is in brackets). An agent's findings on one event combine as noisy-OR, 1 − Π(1 − s). When they reach ${RECALL_AT}, the agent recalls the signals it can see. Each finding of ${WRITE_AT} or more is shared as a signal.`,
  ];
  return [...header, ...AGENTS.flatMap(section)].join("\n") + "\n";
}

function section(a: Agent): string[] {
  const rows = [...a.rules, ...a.contextRules].map((r) => `| \`${r.id}\` | ${r.type} | ${r.when} |`);
  return ["", `## ${TITLES[a.name]} agent`, "", `Sees ${a.sees}.`, "", "| Rule | Signal | Fires when |", "| --- | --- | --- |", ...rows];
}
