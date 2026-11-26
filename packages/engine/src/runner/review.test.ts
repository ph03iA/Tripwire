import assert from "node:assert/strict";
import { test } from "node:test";
import { loginAgent } from "../agents/login.js";
import { aiSignals, type ReviewInput } from "../agents/review.js";
import { ConfigError } from "../config.js";
import { type ChatRequest, LlmError, type LlmClient } from "../llm/client.js";
import { modelNamed } from "../llm/models.js";
import type { LoginEvent, RiskSignal } from "../types.js";
import { llmReviewer } from "./review.js";

const e1: LoginEvent = { id: "evt_1", ts: "2026-11-03T20:40:00.000Z", accountId: "acc_1", kind: "login", success: false, method: "password",
  ip: "49.36.1.1", geo: { country: "IN", city: "Mumbai" }, deviceId: "dev_1", userAgent: "ua" };
const e2: LoginEvent = { ...e1, id: "evt_2", ts: "2026-11-03T20:41:00.000Z", success: true };
const input: ReviewInput = { agent: loginAgent, events: [e1, e2], readings: [], patterns: [] };
const valid = { signals: [{ eventId: "evt_2", type: "credential_stuffing", score: 0.9, evidence: "the success inside the spray" }] };
const models = ["gemini/3.5-flash-lite", "gemini/3.1-flash-lite", "groq/gpt-oss-20b"].map(modelNamed);
const usage = { input: 100, cached: 0, output: 10, total: 110 };

/** A fake client: each model name maps to its answers in turn; an Error is thrown instead of answered. */
function scripted(answers: Record<string, (unknown | Error)[]>) {
  const asked: string[] = [];
  const client: LlmClient = {
    chat: async (req: ChatRequest) => {
      asked.push(req.model.name);
      const next = answers[req.model.name]?.shift();
      if (next instanceof Error) throw next;
      return { json: next, text: JSON.stringify(next), finishReason: "stop", usage, ms: 1, attempts: 1, rateLimited: 0 };
    },
  };
  return { client, asked };
}

test("a valid answer is used as is, and says which model gave it", async () => {
  const { client, asked } = scripted({ "gemini/3.5-flash-lite": [valid] });
  const r = await llmReviewer({ client, models, canUse: () => true })(input);
  assert.deepEqual([r.proposed, r.model, r.calls, r.fallback], [valid.signals, "gemini/3.5-flash-lite", 1, undefined]);
  assert.deepEqual(asked, ["gemini/3.5-flash-lite"]);
});

test("a bad answer is asked once more; a second bad one leaves the rules' signals alone", async () => {
  const bad = { signals: [{ eventId: "evt_9", type: "credential_stuffing", score: 0.9, evidence: "x" }] };
  const retried = await llmReviewer({ client: scripted({ "gemini/3.5-flash-lite": [bad, valid] }).client, models, canUse: () => true })(input);
  assert.deepEqual([retried.proposed, retried.calls], [valid.signals, 2]);
  const twice = await llmReviewer({ client: scripted({ "gemini/3.5-flash-lite": [bad, undefined] }).client, models, canUse: () => true })(input);
  assert.deepEqual(twice.proposed, []);
  assert.match(twice.fallback!, /^invalid answer twice: the answer isn't JSON/);
});

test("a failing or exhausted model hands over to the next and stays out; with none left, the rules stand alone", async () => {
  const { client, asked } = scripted({
    "gemini/3.5-flash-lite": [new LlmError("gemini/3.5-flash-lite: HTTP 429: quota", 429)],
    "groq/gpt-oss-20b": [valid, valid],
  });
  const review = llmReviewer({ client, models, canUse: (m) => m.name !== "gemini/3.1-flash-lite" });
  assert.equal((await review(input)).model, "groq/gpt-oss-20b");
  assert.equal((await review(input)).model, "groq/gpt-oss-20b");
  assert.deepEqual(asked, ["gemini/3.5-flash-lite", "groq/gpt-oss-20b", "groq/gpt-oss-20b"], "the 429'd model isn't asked again");

  const none = await llmReviewer({ client: scripted({}).client, models, canUse: () => false })(input);
  assert.deepEqual(none.proposed, []);
  assert.match(none.fallback!, /^no model left \(gemini\/3\.5-flash-lite: out of today's quota;/);
  await assert.rejects(llmReviewer({ client: scripted({ "gemini/3.5-flash-lite": [new ConfigError("GEMINI_API_KEY is missing")] }).client, models,
    canUse: () => true })(input), ConfigError, "a missing key fails the run instead of running without AI");
});

test("the floor: a proposal is shared only when it adds to what's already shared, as the agent's own ai-review", () => {
  const rule: RiskSignal = { agent: "login", ruleId: "login.failure-burst", type: "credential_stuffing", score: 0.6, accountId: "acc_1", eventId: "evt_1",
    eventKind: "login", ts: e1.ts, entities: { ip: e1.ip, deviceId: e1.deviceId }, evidence: "5 failures in 15 min" };
  const added = aiSignals("login", [
    { eventId: "evt_1", type: "credential_stuffing", score: 0.5, evidence: "lower than the rule" },
    { eventId: "evt_2", type: "credential_stuffing", score: 0.3, evidence: "below what's shared" },
    { eventId: "evt_2", type: "credential_stuffing", score: 0.7, evidence: "inside the spray" },
    { eventId: "evt_2", type: "credential_stuffing", score: 0.9, evidence: " the success inside the spray " },
  ], [e1, e2], [rule]);
  assert.deepEqual(added.map((s) => [s.eventId, s.ruleId, s.score, s.evidence]), [["evt_2", "login.ai-review", 0.9, "the success inside the spray"]]);
  assert.deepEqual(added[0]!.entities, { ip: e1.ip, deviceId: e1.deviceId });
  assert.equal(aiSignals("login", [{ eventId: "evt_1", type: "credential_stuffing", score: 0.8, evidence: "raised" }], [e1, e2], [rule])[0]!.score, 0.8,
    "a higher score than the rule's is shared beside it");
});
