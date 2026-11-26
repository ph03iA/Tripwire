import assert from "node:assert/strict";
import { test } from "node:test";
import { dryMeko } from "../meko/dry.js";
import type { Mcp } from "../meko/mcp.js";
import { UnknownOutcomeError } from "../meko/retry.js";
import type { RiskSignal, TripwireEvent } from "../types.js";
import { mekoSignals, type Retrieval } from "./meko.js";

const T = Date.parse("2026-11-03T10:00:00.000Z");
const at = (hours: number) => new Date(T + hours * 3_600_000).toISOString();
const login = (accountId: string, deviceId: string, ts = at(0)): TripwireEvent =>
  ({ id: `evt_${accountId}_${ts}`, ts, accountId, kind: "login", success: true, method: "password", ip: "49.36.0.1", geo: { country: "IN", city: "Pune" },
    deviceId, userAgent: "ua" });
let n = 0;
const signal = (accountId: string, deviceId: string, ts: string): RiskSignal => ({ agent: "device", ruleId: "device.new-device", type: "new_device",
  score: 0.4, accountId, eventId: `evt_${++n}`, eventKind: "login", ts, entities: { deviceId, ip: `10.0.0.${n}` }, evidence: "a new device" });

/** The ON store over `mcp`, with a manual clock and a record of every wait. */
function store(mcp: Mcp, clock = { now: T }) {
  const retrievals: Retrieval[] = [];
  const waits: number[] = [];
  const signals = mekoSignals({ mcp, datapackId: "dp", run: "run1", caseFor: async (a) => `case-${a}`, log: (r) => void retrievals.push(r),
    wait: async (ms) => void (waits.push(ms), (clock.now += ms)), now: () => clock.now });
  return { signals, retrievals, waits, clock };
}

/** The stand-in, except that memory_search leaves out `hidden` for its first `times` calls: a signal still being indexed. */
function slowIndex(hidden: () => string | undefined, times: number): Mcp {
  const dry = dryMeko();
  let searches = 0;
  return { ...dry, call: async (tool, args, op) => {
    const out = await dry.call(tool, args, op);
    if (tool !== "memory_search" || ++searches > times) return out;
    return { results: (out as { results: { id: string }[] }).results.filter((r) => r.id !== hidden()) };
  } };
}

test("ON recall: one search per event, and only this run's own signals on the same entity inside 72 hours count", async () => {
  const dry = dryMeko();
  const { signals, retrievals } = store(dry);
  const mine = signal("acc_1", "dev_a", at(-1));
  for (const s of [mine, signal("acc_2", "dev_b", at(-1)), signal("acc_1", "dev_a", at(-80))]) await signals.write(s);
  await dry.call("memory_add", { conversation_id: "run1", agent_id: "tripwire:device", text: "[signal] acc_1 dev_a written by someone else" }, "write-once");

  const e = login("acc_1", "dev_a");
  assert.deepEqual(await signals.recall("support", e), [mine], "not acc_2's, not the 80-hour-old one, not the foreign memory");
  assert.deepEqual(await signals.forDecision("login", e), [mine], "the decision reuses the same search");
  assert.equal(dry.calls.get("memory_search"), 1);
  assert.equal(retrievals.length, 1);
  assert.deepEqual([retrievals[0]!.conversationId, retrievals[0]!.agent, retrievals[0]!.usedIds], ["case-acc_1", "tripwire:support", [mine.memoryId]]);
  assert.ok(retrievals[0]!.returnedIds.length > 1, "the search returned more than it used");
  assert.ok(signals.trusted.has(mine.memoryId!) && signals.trusted.size === 3);
});

test("A7: a fresh signal missing from the search is searched for again, and a timeout is recorded, not hidden", async () => {
  let id: string | undefined;
  const late = store(slowIndex(() => id, 1));
  const fresh = signal("acc_1", "dev_a", at(-0.1));
  await late.signals.write(fresh);
  id = fresh.memoryId;
  assert.deepEqual(await late.signals.recall("support", login("acc_1", "dev_a")), [fresh], "found on the second search");
  assert.deepEqual(late.waits, [2000]);
  assert.equal(late.retrievals.length, 2, "both searches are on record");

  const never = store(slowIndex(() => id, 99));
  const lost = signal("acc_1", "dev_a", at(-0.1));
  await never.signals.write(lost);
  id = lost.memoryId;
  assert.deepEqual(await never.signals.recall("support", login("acc_1", "dev_a", at(0.5))), []);
  assert.deepEqual(never.waits, [2000, 4000]);
  assert.deepEqual(never.retrievals.at(-1)!.timedOut, [lost.memoryId]);

  const stale = store(slowIndex(() => id, 99));
  const old = signal("acc_1", "dev_a", at(-0.1));
  await stale.signals.write(old);
  id = old.memoryId;
  stale.clock.now += 60_000; // written a minute ago: a miss now is the search's ranking, not indexing, so it isn't retried
  await stale.signals.recall("support", login("acc_1", "dev_a", at(1)));
  assert.deepEqual(stale.waits, []);
});

test("memory_add with an unknown outcome is found by its key, never sent twice; if it isn't there, the run stops", async () => {
  const dry = dryMeko();
  let adds = 0;
  const lostAnswer: Mcp = { ...dry, call: async (tool, args, op) => {
    if (tool !== "memory_add") return dry.call(tool, args, op);
    adds++;
    await dry.call(tool, args, op); // Meko stored it, but the answer never arrived
    throw new UnknownOutcomeError("memory_add", new Error("socket hang up"));
  } };
  const s = signal("acc_1", "dev_a", at(-1));
  await store(lostAnswer).signals.write(s);
  assert.equal(adds, 1, "never resent");
  assert.equal(s.memoryId, [...dry.memories.keys()][0]);

  const neverStored: Mcp = { ...dry, call: async (tool, args, op) => {
    if (tool === "memory_add") throw new UnknownOutcomeError("memory_add", new Error("socket hang up"));
    return dry.call(tool, args, op);
  } };
  await assert.rejects(store(neverStored).signals.write(signal("acc_1", "dev_a", at(-1))), /isn't in Meko/);
});
