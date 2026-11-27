import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountProfile, LoginEvent, RiskSignal, SignalType } from "../types.js";
import { checkJudgment, guarded, type Judgment, judgmentPrompt, keyOf, namesEntity } from "./judgment.js";

const e: LoginEvent = { id: "evt_9", ts: "2026-11-05T10:00:00.000Z", accountId: "acc_1", kind: "login", success: true, method: "password",
  ip: "27.55.1.1", geo: { country: "TH", city: "Bangkok" }, deviceId: "dev_home", userAgent: "ua" };
const profile: AccountProfile = { id: "acc_1", registeredPhone: "+910000000000", home: { country: "IN", city: "Mumbai" },
  knownDevices: [{ id: "dev_home", userAgent: "ua" }], knownPayees: [], bankPayee: "bnk_1" };
const sig = (ruleId: string, type: SignalType, score: number): RiskSignal => ({ agent: "login", ruleId, type, score, accountId: "acc_1", eventId: "evt_9",
  eventKind: "login", ts: e.ts, entities: { ip: e.ip, deviceId: e.deviceId }, evidence: "x" });
const travel = sig("login.impossible-travel", "impossible_travel", 0.7);
const aiStuffing = sig("login.ai-review", "credential_stuffing", 0.9);
const burst = sig("login.failure-burst", "credential_stuffing", 0.8);
const knowledge = { policy: "# Step-up policy\nBLOCK at risk 0.8 or more.", playbooks: ["# Playbook: travel"] };
const judgment = (over: Partial<Judgment>): Judgment => ({ action: "BLOCK", risk: 0.9, cites: [keyOf(travel)], reasoning: "Far from home.", needMore: "", ...over });

test("the prompt gives the model the policy, the playbooks and the account, and lets it cite only the signals it has", () => {
  const p = judgmentPrompt({ event: e, signals: [travel, aiStuffing], profile }, knowledge);
  assert.ok(p.system.includes(knowledge.policy) && p.system.includes(knowledge.playbooks[0]!));
  assert.match(p.user, /home Mumbai,IN; 1 known devices, and this device is known/);
  assert.match(JSON.stringify(p.schema), /"enum":\["evt_9\/login\.impossible-travel","evt_9\/login\.ai-review"\]/);
  const again = judgmentPrompt({ event: e, signals: [travel], profile, asked: { entity: "device:dev_x" } }, knowledge);
  assert.match(again.system, /need_more: an empty string; you've had your one search/);
  assert.match(again.user, /You asked shared memory for device:dev_x/);
});

test("an answer is checked before it's used", () => {
  const good = { action: "STEP_UP", risk: 0.6, cites: [keyOf(travel)], reasoning: " A new city on the owner's phone. ", need_more: "" };
  assert.deepEqual(checkJudgment(good, [travel]).judgment, { action: "STEP_UP", risk: 0.6, cites: [keyOf(travel)], reasoning: "A new city on the owner's phone.", needMore: "" });
  assert.deepEqual(checkJudgment({ ...good, action: "BLOCK", cites: [], need_more: "ip 1.2.3.4" }, [travel]).problems, ["BLOCK cites no signal", "need_more ip 1.2.3.4 isn't an entity"]);
  assert.deepEqual(checkJudgment({ ...good, cites: ["evt_1/made.up"], risk: -1 }, [travel]).problems, ["risk -1 isn't between 0 and 1", "cites evt_1/made.up, which it wasn't given"]);
  assert.equal(checkJudgment(undefined, [travel]).judgment, undefined);
});

test("guardrails: travel alone on the owner's device never blocks, and a BLOCK needs the rules' own evidence", () => {
  const onTravel = guarded(judgment({}), e, [travel], profile);
  assert.deepEqual([onTravel.action, onTravel.cap, onTravel.risk], ["STEP_UP", "travel", 0.9]);
  assert.match(onTravel.reasoning, /^Far from home\. The only risk is travel/);

  const onAi = guarded(judgment({ cites: [keyOf(aiStuffing)] }), e, [aiStuffing], profile);
  assert.deepEqual([onAi.action, onAi.cap], ["STEP_UP", "ai"]);
  assert.match(onAi.reasoning, /Only the agents' models put it at BLOCK level/);

  const backed = guarded(judgment({ cites: [keyOf(aiStuffing)] }), e, [aiStuffing, burst], profile);
  assert.deepEqual([backed.action, backed.capped], ["BLOCK", false], "the rules' 0.8 burst backs the block");
  assert.deepEqual(guarded(judgment({ action: "ALLOW", cites: [], risk: 0.2 }), e, [travel], profile).action, "ALLOW", "a model may allow");
  assert.deepEqual(guarded(judgment({ action: "STEP_UP", cites: [keyOf(travel)] }), e, [travel], profile).used, [travel]);
});

test("need_more names one entity: a device, an IP address or a payee", () => {
  assert.equal(namesEntity("device:dev_home")!(travel), true);
  assert.equal(namesEntity("ip:27.55.1.1")!(travel), true);
  assert.equal(namesEntity("payee:bnk_9")!(travel), false);
  assert.equal(namesEntity("the attacker's phone"), undefined);
});
