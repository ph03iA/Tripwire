import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountProfile, RiskSignal, SignalType, TripwireEvent } from "../types.js";
import { decide, isSensitive, triggerOf } from "./decision.js";

const client = { ip: "49.36.0.1", geo: { country: "IN", city: "Mumbai" }, deviceId: "dev_home", userAgent: "ua" };
const at = { id: "e1", ts: "2026-11-03T10:00:00.000Z", accountId: "acc_1" };
const event = (body: object) => ({ ...at, ...client, ...body }) as TripwireEvent;
const login = event({ kind: "login", success: true, method: "password" });
const charge = (rupees: number) => event({ kind: "transaction", type: "card_charge", amountMinor: rupees * 100, currency: "INR", status: "approved" });
const profile: AccountProfile = { id: "acc_1", registeredPhone: "+91", home: client.geo, knownDevices: [{ id: "dev_home", userAgent: "ua" }], knownPayees: [], bankPayee: "bnk" };

let n = 0;
const sig = (type: SignalType, score: number, extra: Partial<RiskSignal> = {}): RiskSignal => ({ agent: "device", ruleId: `rule.${type}`, type, score,
  accountId: "acc_1", eventId: `e${++n}`, eventKind: "login", ts: "2026-11-03T09:00:00.000Z", entities: {}, evidence: `${type} seen`, ...extra });

test("C1: sensitive events and strong signals get a decision; everything else is allowed without review", () => {
  assert.ok(isSensitive(event({ kind: "account_change", field: "password", channel: "app" })), "a password change is a credential change");
  assert.ok(isSensitive(event({ kind: "password_reset", channel: "email" })));
  assert.ok(isSensitive(event({ kind: "transaction", type: "transfer", amountMinor: 100, currency: "INR", status: "approved" })), "any transfer");
  assert.ok(!isSensitive(charge(9_999)) && isSensitive(charge(10_000)), "card charges from ₹10,000");
  assert.equal(triggerOf(login, [sig("new_device", 0.6)]), null);
  assert.equal(triggerOf(login, [sig("impossible_travel", 0.7)]), "signal");
  assert.equal(triggerOf(charge(10_000), []), "sensitive");
});

test("C2: the strongest signal of each type, combined as noisy-OR, then the thresholds", () => {
  const stepUp = decide(login, [sig("new_device", 0.4), sig("new_device", 0.4), sig("shared_device", 0.5)], profile);
  assert.deepEqual([stepUp.action, stepUp.risk, stepUp.used.map((s) => s.type)], ["STEP_UP", 0.7, ["shared_device", "new_device"]], "one new_device, not two");
  assert.equal(decide(login, [sig("card_testing", 0.8)], profile).action, "BLOCK", "0.8 is a BLOCK");
  assert.equal(decide(login, [sig("sensitive_change", 0.4)], profile).action, "ALLOW");
  const none = decide(login, [], profile);
  assert.deepEqual([none.action, none.risk], ["ALLOW", 0]);
  assert.match(none.reasoning, /^ALLOW: no risk signals visible/);
});

test("C2: travel alone on a device in the profile is capped at STEP-UP; on any other device it blocks", () => {
  const travel = [sig("impossible_travel", 0.9)];
  const capped = decide(login, travel, profile);
  assert.deepEqual([capped.action, capped.capped], ["STEP_UP", true]);
  assert.match(capped.reasoning, /capped at STEP-UP/);
  assert.equal(decide(event({ kind: "login", success: true, method: "password", deviceId: "dev_new" }), travel, profile).action, "BLOCK");
  assert.equal(decide(login, [...travel, sig("new_device", 0.4)], profile).action, "BLOCK", "travel plus anything else isn't capped");
});

test("the reasoning names each signal, its rule and its account, and the input order changes nothing", () => {
  const signals = [sig("shared_device", 0.7, { accountId: "acc_9", evidence: "device used by 2 other accounts in 7 days" }), sig("new_device", 0.4)];
  const verdict = decide(login, signals, profile);
  assert.equal(verdict.reasoning, "BLOCK: risk 0.82 from shared_device 0.7 on acc_9 (rule.shared_device: device used by 2 other accounts in 7 days); "
    + "new_device 0.4 (rule.new_device: new_device seen). Policy: risk of 0.8 or more is blocked.");
  assert.deepEqual(decide(login, [...signals].reverse(), profile), verdict);
  const tie = [sig("new_device", 0.4, { ts: "2026-11-03T08:00:00.000Z" }), sig("new_device", 0.4, { ts: "2026-11-03T09:30:00.000Z" })];
  assert.equal(decide(login, tie, profile).used[0]!.ts, "2026-11-03T09:30:00.000Z", "a tie goes to the newer signal");
  assert.deepEqual(decide(login, [...tie].reverse(), profile), decide(login, tie, profile));
});
