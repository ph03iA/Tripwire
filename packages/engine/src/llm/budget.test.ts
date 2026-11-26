import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type LoggedCall, logCall, overBudget, usedToday } from "./budget.js";
import { modelNamed } from "./models.js";

const call = (model: string, at: string, attempts: number, total: number, cached = 0): LoggedCall =>
  ({ at, model, source: "test", ok: true, attempts, rateLimited: 0, tokens: { input: total, cached, output: 0, total } });

test("a day's use: Gemini's day starts at midnight Pacific, Groq's is the last 24 hours, and cached input is free", () => {
  const file = join(mkdtempSync(join(tmpdir(), "llm-usage-")), "llm-usage.jsonl");
  const gemini = modelNamed("gemini/3.5-flash-lite");
  const groq = modelNamed("groq/gpt-oss-120b");
  const now = Date.parse("2026-11-27T10:00:00Z"); // 02:00 on Nov 27 in Los Angeles
  for (const c of [
    call("gemini/3.5-flash-lite", "2026-11-27T07:30:00Z", 3, 900), // 23:30 Nov 26 Pacific: yesterday
    call("gemini/3.5-flash-lite", "2026-11-27T08:30:00Z", 2, 500), // 00:30 Nov 27 Pacific: today
    call("gemini/3.1-flash-lite", "2026-11-27T09:00:00Z", 5, 100), // another model
    call("groq/gpt-oss-120b", "2026-11-26T09:00:00Z", 1, 4000), // 25 hours ago
    call("groq/gpt-oss-120b", "2026-11-26T11:00:00Z", 2, 5000, 1000), // 23 hours ago
  ]) logCall(c, file);
  assert.deepEqual(usedToday(gemini, now, file), { requests: 2, tokens: 500 });
  assert.deepEqual(usedToday(groq, now, file), { requests: 2, tokens: 4000 });
  assert.deepEqual(usedToday(groq, now, join(tmpdir(), "no-such-llm-usage.jsonl")), { requests: 0, tokens: 0 });
});

test("the guard refuses what doesn't fit a model's day: requests everywhere, tokens only where the provider caps them", () => {
  const groq = modelNamed("groq/gpt-oss-120b");
  const gemini = modelNamed("gemini/3.5-flash-lite");
  assert.equal(overBudget(groq, { requests: 10, tokens: 150_000 }, { requests: 10, tokens: 40_000 }), null);
  assert.match(overBudget(groq, { requests: 10, tokens: 170_000 }, { requests: 10, tokens: 40_000 })!, /170000 tokens used today \+ 40000 needed > 200000/);
  assert.match(overBudget(gemini, { requests: 495, tokens: 0 }, { requests: 10, tokens: 0 })!, /495 requests used today \+ 10 needed > 500/);
  assert.equal(overBudget(gemini, { requests: 0, tokens: 9_000_000 }, { requests: 10, tokens: 1_000_000 }), null, "Gemini's free tier shows no daily token cap");
});
