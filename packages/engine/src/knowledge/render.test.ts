import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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
