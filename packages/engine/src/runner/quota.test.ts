import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { logUsage, overCeiling, overQuota, preflight, usageOf, usedThisMonth, withHeadroom } from "./quota.js";

test("the quota guard adds up this month's runs and spike checks, and refuses a run that wouldn't fit (R7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tripwire-quota-"));
  const spike = join(dir, "attempts.jsonl");
  const runs = join(dir, "quota.jsonl");
  writeFileSync(spike, [
    JSON.stringify({ ranAt: "2026-11-23T16:00:00.000Z", checks: ["k1"], mcp: { memory_search: 17, conversation_create: 15, conversation_add_message: 5 } }),
    JSON.stringify({ ranAt: "2026-10-30T16:00:00.000Z", checks: ["old"], mcp: { memory_search: 500 } }),
  ].join("\n") + "\n");
  logUsage({ ranAt: "2026-11-26T15:00:00.000Z", runId: "42-on-x", mcp: { memory_search: 300, knowledgebase_search: 80, memory_get_all: 4 } }, runs);
  const used = usedThisMonth("2026-11", [spike, runs, join(dir, "missing.jsonl")]);
  assert.deepEqual(used, { conversationMessages: 5, memorySearches: 317, kbSearches: 80 }, "October and uncounted tools don't count");

  const needed = withHeadroom(usageOf({ memory_search: 400, knowledgebase_search: 60, conversation_add_message: 50 }));
  assert.deepEqual(needed, { conversationMessages: 63, memorySearches: 500, kbSearches: 75 });
  assert.deepEqual(overQuota(used, needed), [], "317 + 500 fits in 1,000");
  assert.deepEqual(overQuota(used, { ...needed, memorySearches: 700 }), ["memorySearches: 317 used this month + 700 needed > 1000"]);
  assert.deepEqual(overCeiling({ conversationMessages: 120, memorySearches: 700, kbSearches: 100 }), [], "exactly the ceiling fits");
});

test("a live run that would break the per-run ceiling is refused even in an empty month (review finding 9)", () => {
  // Regression: the live preflight checked only the monthly quota, so a 121-message estimate passed.
  const empty = usageOf({});
  assert.deepEqual(preflight({ conversationMessages: 121, memorySearches: 0, kbSearches: 0 }, empty), ["conversation messages: 121 needed > 120 per run"]);
  assert.deepEqual(preflight({ conversationMessages: 0, memorySearches: 700, kbSearches: 101 }, empty), ["searches: 801 needed > 800 per run"]);
  assert.deepEqual(preflight({ conversationMessages: 67, memorySearches: 342, kbSearches: 98 }, empty), [], "seed 42's estimate fits");
});
