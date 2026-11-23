import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openStore, type EventStore } from "../store/store.js";
import type { AccountProfile, RiskSignal, TripwireEvent } from "../types.js";
import { deviceAgent } from "./device.js";
import { agentsFor, detect, noisyOr, toSignals } from "./index.js";
import { loginAgent } from "./login.js";
import { supportAgent } from "./support.js";
import { txnAgent } from "./txn.js";
import type { Agent, AgentContext } from "./types.js";

const COMMON_UA = "Mozilla/5.0 (common)";
const RARE_UA = "Mozilla/5.0 (rare)";
const T0 = Date.UTC(2026, 10, 3, 10, 0);
const ts = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const home = { ip: "49.36.0.1", geo: { country: "IN", city: "Mumbai" }, userAgent: COMMON_UA };

let seq = 0;
/** An event for `account` at `minute`, from the account's own phone (`dev_<account>`) at home unless the body says otherwise. */
const ev = (account: string, minute: number, body: Record<string, unknown>) =>
  ({ id: `e${++seq}`, ts: ts(minute), accountId: account, ...home, deviceId: `dev_${account}`, ...body }) as TripwireEvent;
const login = (success: boolean, extra: Record<string, unknown> = {}) =>
  ({ kind: "login", success, method: "password", ...(success ? {} : { failureReason: "bad_password" }), ...extra });
const charge = (paise: number, merchantId: string) => ({ kind: "transaction", type: "card_charge", amountMinor: paise, currency: "INR", merchantId, status: "approved" });
const pay = (type: "transfer" | "payout", paise: number, payeeIsNew: boolean) => ({ kind: "transaction", type, amountMinor: paise, currency: "INR", payeeId: "pay_x", payeeIsNew, status: "approved" });
const call = (method: "kba" | "otp" | "none", intent: string, extra: Record<string, unknown> = {}) =>
  ({ kind: "support_contact", channel: "phone", intent, callerPhone: "+910000000000", callerGeo: home.geo, verification: { method, passed: true }, ...extra });

const profile = (id: string): AccountProfile =>
  ({ id, registeredPhone: "+910000000000", home: home.geo, knownDevices: [{ id: `dev_${id}`, userAgent: COMMON_UA }], knownPayees: [], bankPayee: "bnk_1" });

let store: EventStore;
const ctx = (): AgentContext => ({ history: store, profile, uaShare: (ua) => (ua === RARE_UA ? 0.01 : 0.2) });
before(async () => (store = await openStore()));
after(() => store.close());

type Case = { name: string; history?: TripwireEvent[]; event: TripwireEvent; recalled?: RiskSignal[]; expect: Record<string, number> };

/** Runs each case on its own account, so cases can share one store. Checks the exact rules that fire and their scores. */
async function check(agent: Agent, cases: Case[]) {
  for (const c of cases) {
    for (const e of c.history ?? []) await store.insert(e, ++seq);
    const findings = await detect(agent, c.event, ctx(), async () => c.recalled ?? []);
    assert.deepEqual(Object.fromEntries(findings.map((f) => [f.ruleId, f.score])), c.expect, c.name);
  }
}

test("login agent", () =>
  check(loginAgent, [
    { name: "5th failure in 15 min", history: [1, 2, 3, 4].map((m) => ev("l1", m, login(false))), event: ev("l1", 5, login(false)), expect: { "login.failure-burst": 0.6 } },
    { name: "4 failures is not a burst", history: [1, 2, 3].map((m) => ev("l2", m, login(false))), event: ev("l2", 4, login(false)), expect: {} },
    { name: "10 failures", history: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => ev("l3", m, login(false))), event: ev("l3", 10, login(false)), expect: { "login.failure-burst": 0.8 } },
    { name: "success after 2 failures", history: [ev("l4", 0, login(false)), ev("l4", 1, login(false))], event: ev("l4", 2, login(true)), expect: { "login.failures-then-success": 0.3 } },
    { name: "Mumbai to Bangkok in 2 h", history: [ev("l5", 0, login(true))], event: ev("l5", 120, login(true, { geo: { country: "TH", city: "Bangkok" } })), expect: { "login.impossible-travel": 0.7 } },
    { name: "Mumbai to Delhi in 10 h is fine", history: [ev("l6", 0, login(true))], event: ev("l6", 600, login(true, { geo: { country: "IN", city: "Delhi" } })), expect: {} },
    {
      name: "a failed attempt elsewhere doesn't move the user",
      history: [ev("l7", 0, login(true)), ev("l7", 100, login(false, { geo: { country: "IN", city: "Delhi" } }))],
      event: ev("l7", 110, login(true, { geo: { country: "IN", city: "Delhi" } })),
      expect: {},
    },
    { name: "login after a support reset", history: [ev("l8", 0, { kind: "password_reset", channel: "support" })], event: ev("l8", 20, login(true)), expect: { "login.after-support-reset": 0.7 } },
    { name: "an email reset doesn't count", history: [ev("l9", 0, { kind: "password_reset", channel: "email" })], event: ev("l9", 20, login(true)), expect: {} },
  ]));

test("device agent", () =>
  check(deviceAgent, [
    { name: "known device", event: ev("d1", 0, login(true)), expect: {} },
    { name: "new device", event: ev("d2", 0, login(true, { deviceId: "dev_new2" })), expect: { "device.new-device": 0.4 } },
    { name: "seen on the account before", history: [ev("d3", 0, login(true, { deviceId: "dev_3" }))], event: ev("d3", 5, login(true, { deviceId: "dev_3" })), expect: {} },
    { name: "shared with one other account", history: [ev("d4a", 0, login(true, { deviceId: "dev_4" }))], event: ev("d4", 5, login(true, { deviceId: "dev_4" })), expect: { "device.new-device": 0.4, "device.shared": 0.5 } },
    {
      name: "shared with three other accounts",
      history: ["d5a", "d5b", "d5c"].map((a, i) => ev(a, i, login(true, { deviceId: "dev_5" }))),
      event: ev("d5", 10, login(true, { deviceId: "dev_5" })),
      expect: { "device.new-device": 0.4, "device.shared": 0.8 },
    },
    { name: "rare browser on a known device", event: ev("d6", 0, login(true, { userAgent: RARE_UA })), expect: { "device.rare-ua": 0.2 } },
    { name: "reset from a new device", event: ev("d7", 0, { kind: "password_reset", channel: "support", deviceId: "dev_7" }), expect: { "device.new-device": 0.4, "device.new-after-reset": 0.6 } },
    { name: "new device after a reset", history: [ev("d8", 0, { kind: "password_reset", channel: "email" })], event: ev("d8", 30, login(true, { deviceId: "dev_8" })), expect: { "device.new-device": 0.4, "device.new-after-reset": 0.6 } },
  ]));

test("transaction agent", () =>
  check(txnAgent, [
    { name: "third card check at a third merchant", history: [ev("t1", 0, charge(100, "m1")), ev("t1", 5, charge(200, "m2"))], event: ev("t1", 10, charge(300, "m3")), expect: { "txn.card-testing": 0.6 } },
    { name: "three checks at one merchant", history: [ev("t2", 0, charge(100, "m1")), ev("t2", 5, charge(200, "m1"))], event: ev("t2", 10, charge(300, "m1")), expect: {} },
    {
      name: "big charge after card testing",
      history: [ev("t3", 0, charge(100, "m1")), ev("t3", 5, charge(200, "m2")), ev("t3", 10, charge(300, "m3"))],
      event: ev("t3", 20, charge(2_000_000, "m4")),
      expect: { "txn.cash-out-after-testing": 0.8, "txn.amount-anomaly": 0.4 },
    },
    { name: "₹60,000 to a new payee", event: ev("t4", 0, pay("transfer", 6_000_000, true)), expect: { "txn.high-value-new-payee": 0.5 } },
    { name: "₹1,50,000 to a new payee", event: ev("t5", 0, pay("transfer", 15_000_000, true)), expect: { "txn.high-value-new-payee": 0.6 } },
    { name: "big transfer to a known payee", event: ev("t6", 0, pay("transfer", 15_000_000, false)), expect: {} },
    { name: "payout to a new bank", event: ev("t7", 0, pay("payout", 2_000_000, true)), expect: { "txn.payout-new-bank": 0.4 } },
    { name: "big payout to a new bank", event: ev("t8", 0, pay("payout", 6_000_000, true)), expect: { "txn.payout-new-bank": 0.6 } },
    { name: "10× the usual", history: [1, 2, 3].map((m) => ev("t9", m, pay("transfer", 100_000, false))), event: ev("t9", 10, charge(1_000_000, "m1")), expect: { "txn.amount-anomaly": 0.4 } },
  ]));

test("support agent", () =>
  check(supportAgent, [
    { name: "reset verified by security questions", event: ev("s1", 0, call("kba", "reset_password")), expect: { "support.weak-verification": 0.5 } },
    { name: "email change not verified", event: ev("s2", 0, call("none", "change_email")), expect: { "support.weak-verification": 0.6 } },
    { name: "OTP is strong enough", event: ev("s3", 0, call("otp", "reset_password")), expect: {} },
    { name: "a general question", event: ev("s4", 0, call("kba", "other")), expect: {} },
    { name: "unknown phone at home", event: ev("s5", 0, call("kba", "reset_password", { callerPhone: "+919999999999" })), expect: { "support.weak-verification": 0.5, "support.caller-mismatch": 0.3 } },
    {
      name: "unknown phone, other city",
      event: ev("s6", 0, call("kba", "reset_password", { callerPhone: "+919999999999", callerGeo: { country: "IN", city: "Delhi" } })),
      expect: { "support.weak-verification": 0.5, "support.caller-mismatch": 0.4 },
    },
    { name: "email change on its own", event: ev("s7", 0, { kind: "account_change", field: "email", channel: "web" }), expect: { "support.sensitive-change": 0.4 } },
    {
      name: "email change 30 min after a new-device signal",
      event: ev("s8", 30, { kind: "account_change", field: "email", channel: "web" }),
      recalled: [{ agent: "device", ruleId: "device.new-device", type: "new_device", score: 0.4, accountId: "s8", eventId: "x", ts: ts(0), entities: {}, evidence: "" }],
      expect: { "support.sensitive-change": 0.4, "support.change-after-new-device": 0.6 },
    },
    { name: "a password change isn't sensitive here", event: ev("s9", 0, { kind: "account_change", field: "password", channel: "app" }), expect: {} },
  ]));

test("routing, noisy-OR, recall threshold and signals", async () => {
  const names = (e: TripwireEvent) => agentsFor(e).map((a) => a.name);
  assert.deepEqual(names(ev("r1", 0, login(true))), ["login", "device"]);
  assert.deepEqual(names(ev("r1", 0, pay("transfer", 100, false))), ["device", "txn"]);
  assert.deepEqual(names({ ...call("kba", "other"), id: "x", ts: ts(0), accountId: "r1" } as TripwireEvent), ["support"]);
  assert.deepEqual(names({ kind: "step_up_result", passed: true, id: "y", ts: ts(0), accountId: "r1" }), []);
  assert.equal(noisyOr([0.5, 0.5]), 0.75);
  assert.equal(noisyOr([0.2]), 0.2);
  assert.equal(noisyOr([0.4, 0.6]), 0.76);
  assert.equal(noisyOr([]), 0);

  let recalls = 0;
  const recall = async () => (recalls++, []);
  await detect(deviceAgent, ev("r2", 0, login(true)), ctx(), recall); // nothing fires: no recall
  await detect(deviceAgent, ev("r3", 0, login(true, { userAgent: RARE_UA })), ctx(), recall); // 0.2 reaches the threshold
  assert.equal(recalls, 1);

  const e = ev("r4", 0, pay("payout", 2_000_000, true));
  const signals = toSignals("txn", e, [
    { ruleId: "txn.payout-new-bank", type: "payout_new_bank", score: 0.4, evidence: "a" },
    { ruleId: "device.rare-ua", type: "rare_user_agent", score: 0.2, evidence: "b" },
  ]);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0]!.entities, { ip: home.ip, deviceId: "dev_r4", payeeId: "pay_x", merchantId: undefined });
});
