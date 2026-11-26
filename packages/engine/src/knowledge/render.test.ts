import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BLOCK_AT, REVIEW_SIGNAL_AT, STEP_UP_AT } from "../agents/decision.js";
import { AGENTS } from "../agents/index.js";
import { RISK_RULES_PATH, renderRiskRules } from "./render.js";

test("knowledge/risk-rules.md matches the agents' rules (run `npm run knowledge` after changing a rule)", () => {
  assert.equal(readFileSync(RISK_RULES_PATH, "utf8"), renderRiskRules());
});

test("every rule id is unique and documented with its scores", () => {
  const rules = AGENTS.flatMap((a) => [...a.rules, ...a.contextRules]);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  for (const r of rules) assert.match(r.when, /\(\d\.\d/, `${r.id} doesn't state its score in brackets`);
});

test("knowledge/step-up-policy.md states the thresholds and triggers the decision agent uses (PRD C2)", () => {
  const policy = readFileSync(RISK_RULES_PATH.replace("risk-rules.md", "step-up-policy.md"), "utf8");
  for (const text of [`**BLOCK** at risk ${BLOCK_AT} or more`, `**STEP-UP** at risk from ${STEP_UP_AT} up to ${BLOCK_AT}`, `**ALLOW** below ${STEP_UP_AT}`,
    `a signal scoring ${REVIEW_SIGNAL_AT} or more`, "a change of email, phone, password, payout method or two-factor setting", "₹10,000 or more"]) {
    assert.ok(policy.includes(text), `step-up-policy.md should say "${text}"`);
  }
});
