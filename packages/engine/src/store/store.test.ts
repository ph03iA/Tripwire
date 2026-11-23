import assert from "node:assert/strict";
import { test } from "node:test";
import { generate } from "../generator/generate.js";
import type { TripwireEvent } from "../types.js";
import { openStore } from "./store.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 3, 10, minutes)).toISOString();
const client = { ip: "49.36.1.2", geo: { country: "IN", city: "Pune" }, deviceId: "dev_a", userAgent: "UA" };
const base = (id: string, minutes: number) => ({ id, ts: at(minutes), accountId: "acc_1" });

const fixture: TripwireEvent[] = [
  { ...base("e1", 0), ...client, kind: "login", success: false, method: "password", failureReason: "bad_password" },
  { ...base("e2", 1), ...client, geo: { country: "IN", city: "Delhi" }, kind: "login", success: false, method: "password" },
  { ...base("e3", 2), ...client, kind: "login", success: true, method: "password" },
  { ...base("e4", 3), ...client, kind: "transaction", type: "card_charge", amountMinor: 200, currency: "INR", merchantId: "m1", status: "approved" },
  { ...base("e5", 4), ...client, kind: "transaction", type: "card_charge", amountMinor: 900, currency: "INR", merchantId: "m2", status: "declined" },
  { ...base("e6", 5), ...client, kind: "transaction", type: "transfer", amountMinor: 1_000_000, currency: "INR", payeeId: "p1", payeeIsNew: true, status: "approved" },
  { ...base("e7", 6), ...client, kind: "password_reset", channel: "support" },
  { ...base("e8", 7), accountId: "acc_2", ip: "1.1.1.1", geo: { country: "IN", city: "Mumbai" }, deviceId: "dev_a", userAgent: "UA", kind: "login", success: true, method: "password" },
  { ...base("e9", 8), kind: "support_contact", channel: "phone", intent: "other", callerPhone: "+910", callerGeo: { country: "IN", city: "Goa" },
    verification: { method: "otp", passed: true } },
];

test("history queries answer from inserted events only", async () => {
  const store = await openStore();
  try {
    for (const [i, e] of fixture.entries()) await store.insert(e, i);
    assert.equal(await store.failedLogins("acc_1", at(0)), 2);
    assert.equal(await store.failedLogins("acc_1", at(1)), 1);
    // The last successful activity is the reset at minute 6 in Pune; the support call has no device location.
    assert.deepEqual(await store.lastActivity("acc_1"), { ts: new Date(at(6)), city: "Pune", country: "IN" });
    assert.equal(await store.lastActivity("acc_9"), null);
    // A declined payment elsewhere doesn't move the customer: Delhi survives a later decline in Mumbai.
    const acc3 = { accountId: "acc_3", ...client, deviceId: "dev_c" };
    await store.insert({ ...base("d1", 10), ...acc3, geo: { country: "IN", city: "Delhi" }, kind: "login", success: true, method: "password" }, 100);
    await store.insert({ ...base("d2", 11), ...acc3, geo: { country: "IN", city: "Mumbai" }, kind: "transaction", type: "card_charge",
      amountMinor: 200, currency: "INR", merchantId: "m9", status: "declined" }, 101);
    assert.equal((await store.lastActivity("acc_3"))?.city, "Delhi");
    assert.equal(await store.resetSince("acc_1", at(6)), true);
    assert.equal(await store.resetSince("acc_1", at(6), "support"), true);
    assert.equal(await store.resetSince("acc_1", at(7)), false);
    assert.equal(await store.deviceSeenOnAccount("acc_1", "dev_a"), true);
    assert.equal(await store.deviceSeenOnAccount("acc_1", "dev_b"), false);
    assert.equal(await store.otherAccountsOnDevice("dev_a", "acc_1", at(0)), 1);
    assert.equal(await store.otherAccountsOnDevice("dev_a", "acc_2", at(0)), 1);
    assert.deepEqual(await store.smallCharges("acc_1", at(0)), { count: 2, merchants: ["m1", "m2"] });
    assert.deepEqual(await store.smallCharges("acc_9", at(0)), { count: 0, merchants: [] });
    // A failed login doesn't count as using a device; a charge with no merchant counts as a charge, not a merchant.
    const acc5 = { accountId: "acc_5", ...client, deviceId: "dev_f" };
    await store.insert({ ...base("f1", 20), ...acc5, kind: "login", success: false, method: "password", failureReason: "bad_password" }, 102);
    assert.equal(await store.deviceSeenOnAccount("acc_5", "dev_f"), false);
    await store.insert({ ...base("f2", 21), ...acc5, kind: "transaction", type: "card_charge", amountMinor: 100, currency: "INR", merchantId: "mx", status: "approved" }, 103);
    await store.insert({ ...base("f3", 22), ...acc5, kind: "transaction", type: "card_charge", amountMinor: 100, currency: "INR", status: "approved" }, 104);
    assert.deepEqual(await store.smallCharges("acc_5", at(0)), { count: 2, merchants: ["mx"] });
    assert.deepEqual(await store.medianAmount("acc_1"), { median: 900, count: 3 });
    assert.deepEqual(await store.medianAmount("acc_9"), { median: null, count: 0 });
  } finally {
    await store.close();
  }
});

test("replayed in order, no query ever sees the event being processed or a later one", async () => {
  const { events } = generate(42);
  const sample = events.slice(0, 400);
  const store = await openStore();
  try {
    for (const [i, e] of sample.entries()) {
      const earlier = sample.slice(0, i).filter((x) => x.accountId === e.accountId);
      const expectedFailures = earlier.filter((x) => x.kind === "login" && !x.success).length;
      assert.equal(await store.failedLogins(e.accountId, "2026-01-01T00:00:00Z"), expectedFailures, `at ${e.id}`);
      const last = await store.lastActivity(e.accountId);
      if (last) assert.ok(last.ts.getTime() <= Date.parse(e.ts), `at ${e.id}: saw a later event`);
      await store.insert(e, i);
    }
  } finally {
    await store.close();
  }
});
