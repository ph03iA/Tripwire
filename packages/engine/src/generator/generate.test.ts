import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AccountProfile, Client, TransactionEvent, TripwireEvent } from "../types.js";
import { generate } from "./generate.js";
import { ist } from "./world.js";

const SEEDS = [42, 101, 102, 103, 104, 105];
const cache = new Map<number, ReturnType<typeof generate>>();
const run = (seed: number) => cache.get(seed) ?? cache.set(seed, generate(seed)).get(seed)!;
const hasClient = (e: TripwireEvent): e is TripwireEvent & Client => "deviceId" in e;

test("same seed gives the same stream, different seed a different one", () => {
  assert.deepEqual(generate(7), generate(7));
  assert.notDeepEqual(generate(7).events, generate(8).events);
});

test("at most 2,000 ordered events with unique ids and no leaked labels", () => {
  for (const seed of SEEDS) {
    const { events, labels, accounts } = run(seed);
    assert.ok(events.length > 1900 && events.length <= 2000, `seed ${seed}: ${events.length} events`);
    assert.equal(labels.length, events.length);
    assert.equal(accounts.length, 150);
    assert.equal(new Set(events.map((e) => e.id)).size, events.length);
    events.forEach((e, i) => {
      assert.equal(labels[i]!.eventId, e.id);
      if (i > 0) assert.ok(events[i - 1]!.ts <= e.ts, `seed ${seed}: out of order at ${e.id}`);
      for (const k of ["label", "t", "scenario", "attack", "chainId", "role", "step", "takeoverStep"]) {
        assert.ok(!(k in e), `seed ${seed}: ${e.id} leaks "${k}"`);
      }
    });
  }
});

test("rejects seeds the PRNG can't tell apart and totals too small for the planted events", () => {
  for (const seed of [-1, 1.5, 2 ** 32, Number.NaN]) assert.throws(() => generate(seed), RangeError, `seed ${seed}`);
  assert.throws(() => generate(42, 10), RangeError);
});

test("chains: nine victims, one takeover each, probes never take over, s4 shares a device and payee", () => {
  for (const seed of SEEDS) {
    const { events, labels } = run(seed);
    const chains = new Map<string, number[]>();
    labels.forEach((l, i) => {
      if (l.role === "victim") chains.set(l.chainId!, [...(chains.get(l.chainId!) ?? []), i]);
      if (l.role === "probe") assert.ok(!l.takeoverStep, `seed ${seed}: probe ${l.eventId} takes over`);
    });
    assert.deepEqual([...chains.keys()].sort(), ["s1", "s2", "s3", "s4-1", "s4-2", "s4-3", "s4-4", "s4-5", "s5"]);
    for (const [chain, idx] of chains) {
      assert.equal(idx.filter((i) => labels[i]!.takeoverStep).length, 1, `seed ${seed}: ${chain} takeovers`);
      assert.equal(new Set(idx.map((i) => events[i]!.accountId)).size, 1, `seed ${seed}: ${chain} spans accounts`);
    }
    const ring = labels.flatMap((l, i) => (l.scenario === "s4_fraud_ring" ? [events[i]!] : []));
    assert.equal(new Set(ring.map((e) => e.accountId)).size, 5);
    assert.equal(new Set(ring.filter(hasClient).map((e) => e.deviceId)).size, 1);
    assert.equal(new Set(ring.map((e) => (e.kind === "transaction" ? e.payeeId : "")).filter(Boolean)).size, 1);
  }
});

/** What a detector can see in one event, coarsened into values that can be compared across events. */
function features(e: TripwireEvent, p: AccountProfile): string[] {
  const f: string[] = [];
  if (hasClient(e)) f.push(`ua:${e.userAgent}`, `ip:${e.ip.split(".").slice(0, 2).join(".")}`, `geo:${e.geo.country}/${e.geo.city}`);
  if (e.kind === "login") f.push(`login:${e.success}:${e.method}:${e.failureReason ?? "-"}`);
  if (e.kind === "password_reset") f.push(`reset:${e.channel}`);
  if (e.kind === "account_change") f.push(`change:${e.field}:${e.channel}`);
  if (e.kind === "support_contact") {
    f.push(`support:${e.channel}:${e.intent}:${e.verification.method}:${e.verification.passed}`,
      `caller-on-file:${e.callerPhone === p.registeredPhone}`, `caller-at-home:${e.callerGeo.city === p.home.city}`);
  }
  if (e.kind === "transaction") {
    f.push(`txn:${e.type}:${band(e.amountMinor)}:${e.payeeIsNew ?? "-"}`, `status:${e.status}`, `category:${e.merchantCategory ?? "-"}`);
  }
  return f;
}
const band = (paise: number) => ["<₹50", "<₹1k", "<₹10k", "<₹1L"][[5_000, 100_000, 1_000_000, 10_000_000].findIndex((x) => paise < x)] ?? "≥₹1L";

test("no field value appears only in attacks", () => {
  for (const seed of SEEDS) {
    const { events, labels, accounts } = run(seed);
    const profile = new Map(accounts.map((a) => [a.id, a]));
    const benign = new Set<string>();
    const attackOnly = new Map<string, string>();
    events.forEach((e, i) => {
      for (const f of features(e, profile.get(e.accountId)!)) {
        if (labels[i]!.attack) attackOnly.set(f, e.id);
        else benign.add(f);
      }
    });
    for (const f of benign) attackOnly.delete(f);
    assert.deepEqual([...attackOnly], [], `seed ${seed}: values seen only in attacks`);
  }
});

test("s1/s5 are low and slow, and s5's login carries what an s1 pattern can match", () => {
  for (const seed of SEEDS) {
    const { events, labels } = run(seed);
    const failures = new Map<string, number>();
    events.forEach((e, i) => {
      if (labels[i]!.attack && e.kind === "login" && !e.success) failures.set(e.accountId, (failures.get(e.accountId) ?? 0) + 1);
    });
    assert.ok(Math.max(...failures.values()) <= 3, `seed ${seed}: an account saw more than 3 attacker failures`);
    assert.ok(labels.some((l) => l.chainId === "s5" && l.role === "probe"), `seed ${seed}: s5 keeps the spray`);

    const at = (chain: string, step: number) => events[labels.findIndex((l) => l.chainId === chain && l.role === "victim" && l.step === step)]!;
    const [s1Login, s5Login] = [at("s1", 2), at("s5", 2)];
    assert.ok(hasClient(s1Login) && hasClient(s5Login) && s1Login.userAgent === s5Login.userAgent, `seed ${seed}: browser strings differ`);
    const [s1Payout, s5Payout] = [at("s1", 4) as TransactionEvent, at("s5", 4) as TransactionEvent];
    assert.equal(s1Payout.payeeId, s5Payout.payeeId, `seed ${seed}: different mule accounts`);
    assert.notEqual(s1Payout.accountId, s5Payout.accountId);
  }
});

test("the traveler's phone is known, was last seen at home 2 h before the trip, and nothing else lands in the trip", () => {
  const tripEnd = Date.parse(new Date(ist(10, 0)).toISOString());
  for (const seed of [...SEEDS, 500]) {
    const { events, labels, accounts } = run(seed);
    const trip = events.filter((_, i) => labels[i]!.scenario === "s6_traveler").filter(hasClient);
    const [home, abroad] = [trip[0]!, trip[1]!];
    const profile = accounts.find((a) => a.id === home.accountId)!;
    assert.equal(home.geo.city, profile.home.city, `seed ${seed}: first fixture event isn't at home`);
    assert.equal(abroad.geo.country, "TH");
    assert.equal(home.deviceId, abroad.deviceId);
    assert.ok(profile.knownDevices.some((d) => d.id === home.deviceId), `seed ${seed}: device not in the profile`);
    assert.equal(Date.parse(abroad.ts) - Date.parse(home.ts), 2 * 3_600_000);
    const intruders = events.filter((e, i) =>
      e.accountId === home.accountId && labels[i]!.scenario !== "s6_traveler" && Date.parse(e.ts) >= Date.parse(home.ts) - 3_600_000 && Date.parse(e.ts) < tripEnd);
    assert.deepEqual(intruders.map((e) => e.id), [], `seed ${seed}: other events inside the trip`);
  }
});

test("the CLI writes events, labels and profiles, and rejects a bad seed", () => {
  const cli = fileURLToPath(new URL("./index.ts", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "tripwire-"));
  const node = (seed: string) => [process.execPath, ["--import", "tsx", cli, "--seed", seed, "--out", dir]] as const;
  try {
    execFileSync(...node("7"), { stdio: "pipe" });
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, generate(7).events.length);
    assert.equal(JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")).length, lines.length);
    assert.equal(JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")).length, 150);
    assert.notEqual(spawnSync(...node("4294967296"), { stdio: "pipe" }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
