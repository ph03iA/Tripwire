import assert from "node:assert/strict";
import { test } from "node:test";
import { type BatchSample, checkBatch, checkDecision, type DecisionSample, keyOf, promptFor, samples } from "./check.js";

const all = await samples(42);
const batches = all.filter((s): s is BatchSample => s.kind === "batch");
const decisions = all.filter((s): s is DecisionSample => s.kind === "decision");

test("llm-check's calls come from seed 42: an attack-heavy batch per agent, a decision per attack chain and three legit ones", () => {
  assert.deepEqual(batches.map((b) => [b.agent.name, b.events.length]), [["login", 50], ["device", 50], ["txn", 50], ["support", 31]], "the support agent handles 31 events in all");
  assert.ok(batches.every((b) => b.attacks.length > 0 && b.attacks.length < b.events.length), "each batch mixes attacks and legit events");
  assert.match(batches[0]!.patterns[0]!, /: 16 accounts, 39 events in 27 min \(38 failed logins, 1 successful, 0 other\), median gap 41 s/, "s1's spray, measured");
  assert.deepEqual(decisions.filter((d) => d.attack).map((d) => d.chain), ["s1", "s2", "s3", "s5"]);
  assert.equal(decisions.filter((d) => !d.attack).length, 3);
  assert.ok(decisions.every((d) => d.signals.length > 0), "every decision has evidence to cite");
});

test("the prompts carry no ground truth (PRD R3), and the schemas allow only the batch's events and the given signals", () => {
  for (const s of all) {
    const { user, schema } = promptFor(s);
    assert.doesNotMatch(user, /scenario|chainId|takeoverStep|s1_cred_stuffing|s2_support_reset|s3_card_testing|s4_fraud_ring|s5_repeat_attacker|s6_traveler/, s.id);
    const enums = JSON.stringify(schema).match(/"enum":\[[^\]]*\]/g)!;
    if (s.kind === "batch") assert.ok(enums.some((e) => s.events.every((ev) => e.includes(ev.id))), s.id);
    else assert.ok(enums.some((e) => s.signals.every((sig) => e.includes(keyOf(sig)))), s.id);
  }
});

test("a batch answer is checked before use: unknown events, foreign types, scores outside 0..1 and missing evidence", () => {
  const b = batches[0]!;
  const [first, second] = b.events;
  const good = { signals: [{ eventId: first!.id, type: "credential_stuffing", score: 0.8, evidence: "a burst from one IP" },
    { eventId: second!.id, type: "credential_stuffing", score: 0.2, evidence: "weak" }] };
  assert.deepEqual(checkBatch(good, b), { flagged: [first!.id], problems: [] }, "only scores of 0.4 or more are shared");
  const bad = { signals: [{ eventId: "evt_999999", type: "card_testing", score: 1.4, evidence: " " }] };
  assert.deepEqual(checkBatch(bad, b).problems, [
    "signal 0: event evt_999999 isn't in the batch", "signal 0: type card_testing isn't one of the agent's",
    "signal 0: score 1.4 isn't between 0 and 1", "signal 0: no evidence"]);
  assert.deepEqual(checkBatch({}, b).problems, ["no signals list"]);
});

test("a decision answer is checked against the guardrails: cite only given signals, never stop without one", () => {
  const d = decisions[0]!;
  const key = keyOf(d.signals[0]!);
  const good = { action: "STEP_UP", risk: 0.6, cites: [key], reasoning: "A new payout bank right after an email change.", need_more: "" };
  assert.deepEqual(checkDecision(good, d), { action: "STEP_UP", problems: [] });
  assert.deepEqual(checkDecision({ ...good, need_more: "device:dev_abc" }, d).problems, []);
  assert.deepEqual(checkDecision({ ...good, action: "BLOCK", cites: [] }, d).problems, ["BLOCK cites no signal"]);
  assert.deepEqual(checkDecision({ ...good, cites: ["evt_1/made.up"], risk: 2, need_more: "the attacker" }, d).problems, [
    "risk 2 isn't between 0 and 1", "cites evt_1/made.up, which it wasn't given", "need_more the attacker isn't an entity"]);
  assert.deepEqual(checkDecision(undefined, d).action, undefined);
});
