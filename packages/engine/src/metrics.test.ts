import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMetrics, scoreRun } from "./metrics.js";
import type { Label, TripwireEvent } from "./types.js";

const client = { ip: "49.36.0.1", geo: { country: "IN", city: "Mumbai" }, deviceId: "dev", userAgent: "ua" };
const ev = (id: string, body: object) => ({ id, ts: "2026-11-03T10:00:00.000Z", accountId: "acc", ...client, ...body }) as TripwireEvent;
const pay = (id: string, rupees: number) => ev(id, { kind: "transaction", type: "transfer", amountMinor: rupees * 100, currency: "INR", status: "approved" });
const events = [ev("a1", { kind: "login", success: true, method: "password" }), pay("a2", 50_000), ev("b1", { kind: "login", success: true, method: "password" }),
  pay("b2", 10_000), pay("n1", 2_000), pay("n2", 3_000), ev("p1", { kind: "login", success: false, method: "password" }),
  ev("n3", { kind: "login", success: true, method: "password" })]; // a legit login with a strong signal: reviewed, but not sensitive
const victim = (eventId: string, chainId: string, step: number, takeoverStep?: true): Label =>
  ({ eventId, scenario: "s4_fraud_ring", attack: true, chainId, role: "victim", step, ...(takeoverStep ? { takeoverStep } : {}) });
const labels: Label[] = [victim("a1", "A", 1), victim("a2", "A", 2, true), victim("b1", "B", 1), victim("b2", "B", 2, true),
  { eventId: "n1", scenario: "normal", attack: false }, { eventId: "n2", scenario: "normal", attack: false },
  { eventId: "p1", scenario: "s1_cred_stuffing", attack: true, chainId: "s1", role: "probe", step: 1 }, { eventId: "n3", scenario: "s6_traveler", attack: false }];

test("metrics come from what was refused: chain A stopped a phase early, chain B's money left, and legit friction is counted", () => {
  const decisions = [{ eventId: "a1", action: "BLOCK" }, { eventId: "n1", action: "STEP_UP" }, { eventId: "n2", action: "BLOCK" },
    { eventId: "b2", action: "STEP_UP" }, { eventId: "p1", action: "BLOCK" }, { eventId: "n3", action: "STEP_UP" }];
  const m = scoreRun({ decisions, refused: new Set(["a1", "a2", "n2", "p1"]) }, events, labels);
  assert.deepEqual(m.chains.map((c) => [c.chainId, c.prevented, c.stoppedAt, c.stepsEarly]), [["A", true, 1, 1], ["B", false, null, null]],
    "B's step-up was passed, so a decision alone doesn't count as a stop; the probe isn't a chain");
  assert.deepEqual([m.prevented, m.caughtEarly, m.avgStepsEarly, m.lossPreventedMinor, m.lossAtRiskMinor], [1, 1, 1, 5_000_000, 6_000_000]);
  assert.deepEqual([m.legitSensitive, m.legitSensitiveBlocks, m.legitSensitiveStepUps, m.legitRefused], [2, 1, 1, 1]);
  // Regression (review finding 8): the login's STEP-UP counts among all legit events, not in the sensitive-event rate.
  assert.deepEqual([m.legitBlocks, m.legitStepUps], [1, 2]);
  assert.match(formatMetrics(m), /prevented 1 of 2, caught early 1/);
  assert.match(formatMetrics(m), /legit sensitive events 2: BLOCK 1 \(50\.0%\), STEP-UP 1 \(50\.0%\)/);
  assert.match(formatMetrics(m), /all legit events: BLOCK 1, STEP-UP 2/);
});
