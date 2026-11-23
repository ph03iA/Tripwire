import assert from "node:assert/strict";
import { test } from "node:test";
import { generate } from "../generator/generate.js";
import type { TripwireEvent } from "../types.js";
import { replay, replayStream, type RunRecord } from "./replay.js";

const { events, labels, accounts } = generate(42);
let cached: RunRecord | undefined;
const run = async () => (cached ??= await replay(42));

/** "ruleId score" for every shared signal on a victim's events in one phase of a chain. */
async function signalsAt(chainId: string, step: number): Promise<string[]> {
  const ids = new Set(labels.filter((l) => l.chainId === chainId && l.role === "victim" && l.step === step).map((l) => l.eventId));
  return (await run()).signals.filter((s) => ids.has(s.eventId)).map((s) => `${s.ruleId} ${s.score}`);
}

test("an OFF replay of seed 42 completes over every event", async () => {
  const record = await run();
  assert.equal(record.error, undefined);
  assert.equal(record.status, "ok");
  assert.equal(record.events, events.length);
  assert.ok(record.signals.every((s) => s.score >= 0.4), "only findings of 0.4 or more are shared");
});

test("s2: every phase of the support-desk takeover leaves a signal", async () => {
  assert.deepEqual((await signalsAt("s2", 1)).sort(), ["support.caller-mismatch 0.4", "support.weak-verification 0.5"]);
  assert.ok((await signalsAt("s2", 2)).includes("device.new-after-reset 0.6"));
  assert.ok((await signalsAt("s2", 3)).includes("login.after-support-reset 0.7"));
  assert.ok((await signalsAt("s2", 4)).includes("txn.high-value-new-payee 0.6"));
});

test("s3: card checks, then the cash-out", async () => {
  assert.ok((await signalsAt("s3", 1)).includes("txn.card-testing 0.6"));
  assert.ok((await signalsAt("s3", 2)).includes("txn.cash-out-after-testing 0.8"));
});

test("s4: the device agent sees the ring grow, account by account", async () => {
  const shared = async (chain: string) => (await signalsAt(chain, 1)).filter((s) => s.startsWith("device.shared"));
  assert.deepEqual(await shared("s4-1"), []);
  assert.deepEqual(await Promise.all(["s4-2", "s4-3", "s4-4", "s4-5"].map(shared)),
    [["device.shared 0.5"], ["device.shared 0.7"], ["device.shared 0.8"], ["device.shared 0.8"]]);
});

test("s1/s5: low and slow, so no burst; in OFF the support agent can't see the new device", async () => {
  const attacked = new Set(labels.flatMap((l, i) => (l.chainId === "s1" || l.chainId === "s5" ? [events[i]!.accountId] : [])));
  const record = await run();
  const burst = record.findings.filter((f) => f.ruleId === "login.failure-burst" && attacked.has(events.find((e) => e.id === f.eventId)!.accountId));
  assert.deepEqual(burst, []);
  for (const chain of ["s1", "s5"]) {
    const atChange = await signalsAt(chain, 3);
    assert.ok(atChange.includes("support.sensitive-change 0.4"), `${chain}: ${atChange}`);
    assert.ok(!atChange.includes("support.change-after-new-device 0.6"), `${chain}: OFF mode leaked another agent's signal`);
    assert.ok((await signalsAt(chain, 4)).includes("txn.payout-new-bank 0.6"));
  }
});

test("s6: the traveler trips impossible travel", async () => {
  const trip = labels.filter((l) => l.scenario === "s6_traveler").map((l) => l.eventId)[1]!; // the Bangkok login
  assert.ok((await run()).signals.some((s) => s.eventId === trip && s.ruleId === "login.impossible-travel"));
});

test("the same seed replays to the same findings", async () => {
  const again = await replay(42);
  assert.deepEqual(again.findings, (await run()).findings);
});

test("a broken input fails the run and says why, instead of passing as a partial run", async () => {
  const record = await replayStream({ seed: 0, events: events.slice(0, 3), accounts: accounts.slice(0, 1) });
  assert.equal(record.status, "failed");
  assert.match(record.error ?? "", /has no profile/);
  assert.equal(record.events, 0);
});

// Two hand-built events for one real account, on its own known phone at home.
const acc = accounts[0]!;
const own = { accountId: acc.id, ip: "49.36.1.1", geo: acc.home, deviceId: acc.knownDevices[0]!.id, userAgent: acc.knownDevices[0]!.userAgent };
const reset = (id: string, ts: string) => ({ ...own, id, ts, kind: "password_reset", channel: "support" }) as TripwireEvent;
const login = (id: string, ts: string) => ({ ...own, id, ts, kind: "login", success: true, method: "password" }) as TripwireEvent;
const payout = (id: string, ts: string) =>
  ({ ...own, id, ts, kind: "transaction", type: "payout", amountMinor: 2_000_000, currency: "INR", payeeId: "bnk_new", payeeIsNew: true, status: "approved" }) as TripwireEvent;

test("out-of-order input fails before anything is scored, instead of using future evidence", async () => {
  // Regression: a login at 01:10 used to score login.after-support-reset (0.7) from a reset at 01:30.
  const record = await replayStream({ seed: 0, accounts: [acc], events: [reset("r", "2026-11-03T01:30:00.000Z"), login("l", "2026-11-03T01:10:00.000Z")] });
  assert.equal(record.status, "failed");
  assert.match(record.error ?? "", /time order/);
  assert.deepEqual(record.findings, []);

  const sameTime = await replayStream({ seed: 0, accounts: [acc], events: [reset("r", "2026-11-03T01:30:00.000Z"), login("l", "2026-11-03T01:30:00.000Z")] });
  assert.equal(sameTime.status, "ok", "equal timestamps keep their input order");
});

test("a failed insert publishes nothing from that event, so the record's counts agree", async () => {
  const one = await replayStream({ seed: 0, accounts: [acc], events: [payout("dup", "2026-11-03T05:00:00.000Z")] });
  const twice = await replayStream({ seed: 0, accounts: [acc], events: [payout("dup", "2026-11-03T05:00:00.000Z"), payout("dup", "2026-11-03T05:01:00.000Z")] });
  assert.equal(twice.status, "failed");
  assert.equal(twice.events, 1);
  assert.equal(twice.signals.length, one.signals.length, "only the stored event's signals");
  assert.equal(twice.findings.length, one.findings.length, "only the stored event's findings");
});
