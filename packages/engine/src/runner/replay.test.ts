import assert from "node:assert/strict";
import { test } from "node:test";
import { generate } from "../generator/generate.js";
import type { Label, TripwireEvent } from "../types.js";
import { replay, replayStream, type RunRecord } from "./replay.js";

const { events, labels, accounts } = generate(42);
let cached: RunRecord | undefined;
const run = async () => (cached ??= await replay(42));

const victimEvents = (chainId: string, step: number) =>
  labels.filter((l) => l.chainId === chainId && l.role === "victim" && l.step === step).map((l) => l.eventId);

/** "ruleId score" for every shared signal on a victim's events in one phase of a chain. */
async function signalsAt(chainId: string, step: number): Promise<string[]> {
  const ids = new Set(victimEvents(chainId, step));
  return (await run()).signals.filter((s) => ids.has(s.eventId)).map((s) => `${s.ruleId} ${s.score}`);
}

test("an OFF replay of seed 42 completes over every event", async () => {
  const record = await run();
  assert.equal(record.error, undefined);
  assert.equal(record.status, "ok");
  assert.equal(record.events, events.length, "every event is stored or refused");
  assert.ok(record.signals.every((s) => s.score >= 0.4), "only findings of 0.4 or more are shared");
});

test("s2: each phase up to the stop leaves a signal, and the transfer after it is refused", async () => {
  assert.deepEqual((await signalsAt("s2", 1)).sort(), ["support.caller-mismatch 0.4", "support.weak-verification 0.5"]);
  assert.ok((await signalsAt("s2", 2)).includes("device.new-after-reset 0.6"));
  assert.ok((await signalsAt("s2", 3)).includes("login.after-support-reset 0.7"));
  const [transfer] = victimEvents("s2", 4);
  assert.deepEqual((await run()).denied.filter((d) => d.eventId === transfer).map((d) => d.rule), ["lock.device"]);
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

test("OFF: every chain is stopped where the design's OFF column expects, with no false-positive BLOCK", async () => {
  const { metrics } = await run();
  assert.deepEqual(Object.fromEntries(metrics!.chains.map((c) => [c.chainId, c.stoppedAt])),
    { s1: 4, s2: 3, s3: 2, "s4-1": null, "s4-2": null, "s4-3": null, "s4-4": null, "s4-5": null, s5: 4 });
  assert.equal(metrics!.caughtEarly, 1, "only s2, at its login");
  assert.equal(metrics!.legitBlocks, 0);
  assert.equal(metrics!.legitSensitiveBlocks, 0);
  assert.equal(metrics!.legitRefused, 0);
});

test("s6: the traveler trips impossible travel, is stepped up, passes, and is never blocked", async () => {
  const trip = labels.filter((l) => l.scenario === "s6_traveler").map((l) => l.eventId);
  const record = await run();
  assert.ok(record.signals.some((s) => s.eventId === trip[1] && s.ruleId === "login.impossible-travel"), "the Bangkok login");
  assert.deepEqual(record.decisions.filter((d) => trip.includes(d.eventId)).map((d) => [d.eventId, d.action, d.outcome]),
    [[trip[1], "STEP_UP", "passed"]]);
});

test("the same seed replays to the same findings and decisions", async () => {
  const again = await replay(42);
  const decisions = (r: RunRecord) => r.decisions.map((d) => ({ ...d, latencyMs: 0 })); // wall time is the one thing that varies
  assert.deepEqual(again.findings, (await run()).findings);
  assert.deepEqual(decisions(again), decisions(await run()));
});

const legit = (stream: TripwireEvent[], attacks: string[] = []): Label[] =>
  stream.map((e) => ({ eventId: e.id, scenario: "normal", attack: attacks.includes(e.id) }));

test("a broken input fails the run and says why, instead of passing as a partial run", async () => {
  const three = events.slice(0, 3);
  const record = await replayStream({ seed: 0, events: three, labels: legit(three), accounts: accounts.slice(0, 1) });
  assert.equal(record.status, "failed");
  assert.match(record.error ?? "", /has no profile/);
  assert.equal(record.events, 0);
  const unlabelled = await replayStream({ seed: 0, events: three, labels: [], accounts });
  assert.match(unlabelled.error ?? "", /has no label/);
  assert.equal(unlabelled.metrics, undefined, "a failed run carries no metrics");
});

// Hand-built events for two real accounts, on the first one's own phone at home unless a device is given.
const [acc, other] = [accounts[0]!, accounts[1]!];
const own = { accountId: acc.id, ip: "49.36.1.1", geo: acc.home, deviceId: acc.knownDevices[0]!.id, userAgent: acc.knownDevices[0]!.userAgent };
const reset = (id: string, ts: string) => ({ ...own, id, ts, kind: "password_reset", channel: "support" }) as TripwireEvent;
const login = (id: string, ts: string, extra: object = {}) => ({ ...own, id, ts, kind: "login", success: true, method: "password", ...extra }) as TripwireEvent;
const payout = (id: string, ts: string, extra: object = {}) =>
  ({ ...own, id, ts, kind: "transaction", type: "payout", amountMinor: 2_000_000, currency: "INR", payeeId: "bnk_new", payeeIsNew: true,
    status: "approved", ...extra }) as TripwireEvent;

test("out-of-order input fails before anything is scored, instead of using future evidence", async () => {
  // Regression: a login at 01:10 used to score login.after-support-reset (0.7) from a reset at 01:30.
  const backwards = [reset("r", "2026-11-03T01:30:00.000Z"), login("l", "2026-11-03T01:10:00.000Z")];
  const record = await replayStream({ seed: 0, accounts: [acc], events: backwards, labels: legit(backwards) });
  assert.equal(record.status, "failed");
  assert.match(record.error ?? "", /time order/);
  assert.deepEqual(record.findings, []);

  const together = [reset("r", "2026-11-03T01:30:00.000Z"), login("l", "2026-11-03T01:30:00.000Z")];
  const sameTime = await replayStream({ seed: 0, accounts: [acc], events: together, labels: legit(together) });
  assert.equal(sameTime.status, "ok", "equal timestamps keep their input order");
});

test("a failed insert publishes nothing from that event, so the record's counts agree", async () => {
  const single = [payout("dup", "2026-11-03T05:00:00.000Z")];
  const double = [...single, payout("dup", "2026-11-03T05:01:00.000Z")];
  const one = await replayStream({ seed: 0, accounts: [acc], events: single, labels: legit(single) });
  const twice = await replayStream({ seed: 0, accounts: [acc], events: double, labels: legit(double) });
  assert.equal(twice.status, "failed");
  assert.equal(twice.events, 1);
  assert.equal(twice.signals.length, one.signals.length, "only the stored event's signals");
  assert.equal(twice.findings.length, one.findings.length, "only the stored event's findings");
});

test("a failed step-up stops the attacker: their device is refused everywhere, and the account refuses unverified devices", async () => {
  const big = (deviceId: string) => ({ amountMinor: 6_000_000, deviceId }); // ₹60,000 to a new bank: 0.6, so a STEP-UP
  const stream = [
    payout("z1", "2026-11-03T04:00:00.000Z", big("dev_new_phone")), // the owner on a new phone: passes, so it's verified
    payout("p1", "2026-11-03T05:00:00.000Z", big("dev_thief")), // the attacker: fails, so the account and dev_thief are locked
    login("l1", "2026-11-03T05:10:00.000Z", { accountId: other.id, deviceId: "dev_thief" }), // the thief's device, another account
    payout("p2", "2026-11-03T05:20:00.000Z", big("dev_unknown")), // the account, from a device it never verified
    payout("p3", "2026-11-03T05:30:00.000Z", big("dev_new_phone")), // the verified phone still works
  ];
  const record = await replayStream({ seed: 0, accounts: [acc, other], events: stream, labels: legit(stream, ["p1", "l1", "p2"]) });
  assert.equal(record.error, undefined);
  assert.deepEqual(record.decisions.map((d) => [d.eventId, d.action, d.outcome]),
    [["z1", "STEP_UP", "passed"], ["p1", "STEP_UP", "failed"], ["p3", "STEP_UP", "passed"]]);
  assert.deepEqual(record.denied.map((d) => [d.eventId, d.rule, d.stopEventId]), [["l1", "lock.device", "p1"], ["p2", "lock.unverified-device", "p1"]]);
  assert.deepEqual(record.stepUps.map((s) => [s.id, s.passed]), [["z1-otp", true], ["p1-otp", false], ["p3-otp", true]]);
  assert.equal(record.events, stream.length);
});

test("a payout stopped at its step-up doesn't become the owner's last location (review finding 2)", async () => {
  // Regression: the owner's next login at home scored "Bangkok to Mumbai would need 3002 km/h" and got a STEP-UP.
  const mumbai = accounts.find((a) => a.home.city === "Mumbai")!;
  const home = { ip: "49.36.1.1", geo: mumbai.home, deviceId: mumbai.knownDevices[0]!.id, userAgent: mumbai.knownDevices[0]!.userAgent };
  const stream = [
    { ...home, id: "h1", ts: "2026-11-03T04:00:00.000Z", accountId: mumbai.id, kind: "login", success: true, method: "password" },
    { id: "x1", ts: "2026-11-03T05:00:00.000Z", accountId: mumbai.id, ip: "27.55.1.1", geo: { country: "TH", city: "Bangkok" }, deviceId: "dev_thief",
      userAgent: "ua", kind: "transaction", type: "payout", amountMinor: 6_000_000, currency: "INR", payeeId: "bnk_new", payeeIsNew: true, status: "approved" },
    { ...home, id: "h2", ts: "2026-11-03T06:00:00.000Z", accountId: mumbai.id, kind: "login", success: true, method: "password" },
  ] as TripwireEvent[];
  const record = await replayStream({ seed: 0, events: stream, labels: legit(stream, ["x1"]), accounts: [mumbai] });
  assert.equal(record.error, undefined);
  assert.deepEqual(record.decisions.map((d) => [d.eventId, d.action, d.outcome]), [["x1", "STEP_UP", "failed"]], "no decision on the owner's login");
  assert.deepEqual(record.findings.filter((f) => f.eventId === "h2").map((f) => f.ruleId), []);
});
