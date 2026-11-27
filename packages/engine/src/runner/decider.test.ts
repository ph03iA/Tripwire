import assert from "node:assert/strict";
import { test } from "node:test";
import { keyOf } from "../agents/judgment.js";
import { ConfigError } from "../config.js";
import { type ChatRequest, LlmError, type LlmClient } from "../llm/client.js";
import { DECISION_MODELS, modelNamed } from "../llm/models.js";
import type { LoginEvent, RiskSignal } from "../types.js";
import { llmDecider } from "./decider.js";

const e: LoginEvent = { id: "evt_9", ts: "2026-11-05T10:00:00.000Z", accountId: "acc_1", kind: "login", success: true, method: "password",
  ip: "27.55.1.1", geo: { country: "IN", city: "Mumbai" }, deviceId: "dev_new", userAgent: "ua" };
const signal = (eventId: string, ruleId: string): RiskSignal => ({ agent: "login", ruleId, type: "new_device", score: 0.4, accountId: "acc_1", eventId,
  eventKind: "login", ts: e.ts, entities: { deviceId: "dev_new" }, evidence: "x" });
const own = signal("evt_9", "device.new-device");
const elsewhere = { ...signal("evt_3", "device.shared"), accountId: "acc_2" };
const input = { event: e, signals: [own], profile: undefined };
const knowledge = { policy: "policy", playbooks: [] };
const models = DECISION_MODELS.map(modelNamed);
const usage = { input: 100, cached: 0, output: 10, total: 110 };
const answer = (over: Record<string, unknown> = {}) => ({ action: "STEP_UP", risk: 0.6, cites: [keyOf(own)], reasoning: "New device.", need_more: "", ...over });

function scripted(answers: Record<string, (unknown | Error)[]>) {
  const asked: ChatRequest[] = [];
  const client: LlmClient = {
    chat: async (req) => {
      asked.push(req);
      const next = answers[req.model.name]?.shift();
      if (next instanceof Error) throw next;
      return { json: next, text: JSON.stringify(next), finishReason: "stop", usage, ms: 1, attempts: 1, rateLimited: 0 };
    },
  };
  return { client, asked };
}
const noLookup = async () => { throw new Error("no search expected"); };

test("a valid judgment is used, with the model that made it", async () => {
  const { client } = scripted({ "gemini/3.1-flash-lite": [answer()] });
  const r = await llmDecider({ client, models, knowledge, canUse: () => true })(input, noLookup);
  assert.deepEqual([r.judgment?.action, r.model, r.calls, r.fallback], ["STEP_UP", "gemini/3.1-flash-lite", 1, undefined]);
});

test("need_more: one search, then one more question that can cite what it found", async () => {
  const { client, asked } = scripted({ "gemini/3.1-flash-lite": [answer({ need_more: "device:dev_new" }), answer({ action: "BLOCK", cites: [keyOf(own), keyOf(elsewhere)] })] });
  const searched: string[] = [];
  const r = await llmDecider({ client, models, knowledge, canUse: () => true })(input, async (entity) => (searched.push(entity), [own, elsewhere]));
  assert.deepEqual(searched, ["device:dev_new"]);
  assert.deepEqual([r.judgment?.action, r.calls, r.needMore], ["BLOCK", 2, { entity: "device:dev_new", found: 1 }]);
  assert.deepEqual(r.signals.map(keyOf), [keyOf(own), keyOf(elsewhere)], "the found signal joins the ones it had, once");
  assert.match(JSON.stringify(asked[1]!.schema), new RegExp(keyOf(elsewhere).replace(".", "\\.")), "the second question may cite it");

  const keepsFirst = scripted({ "gemini/3.1-flash-lite": [answer({ need_more: "device:dev_new" }), { action: "MAYBE" }, { action: "MAYBE" }] });
  const kept = await llmDecider({ client: keepsFirst.client, models, knowledge, canUse: () => true })(input, async () => [elsewhere]);
  assert.deepEqual([kept.judgment?.action, kept.signals, kept.calls], ["STEP_UP", [own], 3], "two bad second answers keep the first judgment");
});

test("two bad answers leave the decision to the rules; a failing model hands over; none left, the rules decide", async () => {
  const bad = await llmDecider({ client: scripted({ "gemini/3.1-flash-lite": [answer({ cites: [] , action: "BLOCK" }), answer({ risk: 7 })] }).client, models, knowledge,
    canUse: () => true })(input, noLookup);
  assert.equal(bad.judgment, undefined);
  assert.equal(bad.fallback, "invalid answer twice: risk 7 isn't between 0 and 1");

  const { client, asked } = scripted({ "gemini/3.1-flash-lite": [new LlmError("down", 503)], "groq/gpt-oss-120b": [answer(), answer()] });
  const decider = llmDecider({ client, models, knowledge, canUse: () => true });
  assert.equal((await decider(input, noLookup)).model, "groq/gpt-oss-120b");
  assert.equal((await decider(input, noLookup)).model, "groq/gpt-oss-120b");
  assert.deepEqual(asked.map((r) => r.model.name), ["gemini/3.1-flash-lite", "groq/gpt-oss-120b", "groq/gpt-oss-120b"]);

  const none = await llmDecider({ client: scripted({}).client, models, knowledge, canUse: () => false })(input, noLookup);
  assert.match(none.fallback!, /^no model left \(gemini\/3\.1-flash-lite: out of today's quota;/);
  await assert.rejects(llmDecider({ client: scripted({ "gemini/3.1-flash-lite": [new ConfigError("GEMINI_API_KEY is missing")] }).client, models, knowledge,
    canUse: () => true })(input, noLookup), ConfigError);
});
