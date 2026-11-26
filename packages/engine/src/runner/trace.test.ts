import assert from "node:assert/strict";
import { test } from "node:test";
import { dryMeko } from "../meko/dry.js";
import type { Mcp } from "../meko/mcp.js";
import { MekoError } from "../meko/retry.js";
import { openTrace } from "./trace.js";

const options = (mcp: Mcp) => ({ mcp, runId: "42-on-test", datapacks: { signals: "s", patterns: "p" }, wait: async () => {} });
const gatewayDown = () => new MekoError("bad gateway", 502); // transient: the call may or may not have been applied

/** The stand-in, except that `tool` loses its answer `times` times: once after doing the work (`applied`), or without doing it. */
function losesAnswers(tool: string, applied: boolean, times = 1) {
  const dry = dryMeko();
  let lost = 0;
  const mcp: Mcp = { ...dry, call: async (name, args, op) => {
    if (name !== tool || lost >= times) return dry.call(name, args, op);
    lost++;
    if (applied) await dry.call(name, args, op);
    throw gatewayDown();
  } };
  return { dry, mcp };
}

test("a conversation whose create lost its answer is found by its known ID; one that was never made stops the run", async () => {
  const made = losesAnswers("conversation_create", true);
  const trace = await openTrace(options(made.mcp));
  assert.ok(made.dry.conversations.has(trace.run));
  await assert.rejects(openTrace(options(losesAnswers("conversation_create", false).mcp)), /not_found/);
});

test("a trace turn whose answer was lost is looked up after a wait; a missing one stops the run (C4)", async () => {
  const kept = losesAnswers("conversation_add_message", true);
  const trace = await openTrace(options(kept.mcp));
  const turn = { eventId: "evt_1", action: "BLOCK" as const, outcome: "blocked", reasoning: "why", record: { eventId: "evt_1" } };
  await trace.flagged(turn, "acc_1");
  assert.equal(kept.dry.conversations.get(trace.caseOf("acc_1")!)!.messages.length, 1, "stored once");

  const lost = losesAnswers("conversation_add_message", false);
  const again = await openTrace(options(lost.mcp));
  await assert.rejects(again.flagged(turn, "acc_1"), /may be missing/);
});

test("the R8 audit deletes every memory the run didn't write, and fails if one can't be deleted", async () => {
  const dry = dryMeko();
  const trace = await openTrace(options(dry));
  const mine = await dry.call("memory_add", { conversation_id: trace.run, agent_id: "tripwire:txn", text: "a signal" }, "write-once") as { results: { id: string }[] };
  await dry.call("memory_add", { conversation_id: "elsewhere", agent_id: "someone", text: "not ours" }, "write-once");
  await trace.ledger("2026-11-03T10:00:00.000Z", "a line"); // its turn is mined for a memory (K6)
  const audit = await trace.finish(new Set([mine.results[0]!.id]));
  assert.deepEqual(audit, { kept: 1, deleted: 2 });
  assert.deepEqual([...dry.memories.keys()], [mine.results[0]!.id]);

  const blind = await openTrace(options(dryMeko()));
  await assert.rejects(blind.finish(new Set(["mem-that-the-listing-never-shows"])), /listing is missing 1 of this run's 1 signals/,
    "an audit that can't see the run's own signals proves nothing");

  const stuck = dryMeko();
  const noDeletes: Mcp = { ...stuck, call: (tool, args, op) => (tool === "memory_delete_by_id" ? Promise.resolve({}) : stuck.call(tool, args, op)) };
  const stuckTrace = await openTrace(options(noDeletes));
  await stuck.call("memory_add", { conversation_id: "elsewhere", agent_id: "someone", text: "not ours" }, "write-once");
  await assert.rejects(stuckTrace.finish(new Set()), /hygiene audit \(R8\): 1 memories/);
});

test("the ledger is sent one day at a time, split into parts that fit one turn", async () => {
  const dry = dryMeko();
  const trace = await openTrace(options(dry));
  const line = "x".repeat(99);
  for (let i = 0; i < 250; i++) await trace.ledger("2026-11-03T10:00:00.000Z", `${String(i).padStart(3, "0")} ${line}`);
  await trace.ledger("2026-11-04T00:00:00.000Z", "next day");
  const outputs = dry.conversations.get(trace.conversations().ledger)!.messages.map((m) => m.output);
  assert.equal(outputs.length, 3, "25,000 characters in parts of at most 12,000");
  assert.ok(outputs.every((o) => o.split("\n").slice(1).join("\n").length <= 12_000));
  assert.match(outputs[0]!, /^Allow ledger for 2026-11-03, part 1 of 3/);
  assert.ok(!outputs.join("").includes("next day"), "a day is sent when the next one starts");
});
