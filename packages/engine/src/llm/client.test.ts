import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError } from "../config.js";
import { type CallEntry, type ChatRequest, LlmError, llmClient } from "./client.js";
import { modelNamed } from "./models.js";

const env = { GROQ_API_KEY: "gsk_test_groq", GEMINI_API_KEY: "gemini_test_key" };
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const ask = (model: string): ChatRequest => ({ model: modelNamed(model), system: "be brief", user: "ok?", schemaName: "probe", schema: SCHEMA });
const completion = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage }), { status: 200 });

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A fake fetch that answers in turn and records each request; a clock that only moves when waited on. */
function fake(answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const waits: number[] = [];
  const calls: CallEntry[] = [];
  let clock = Date.parse("2026-11-27T10:00:00Z");
  const send = (async (url: URL, init: RequestInit) => {
    sent.push({ url: url.href, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  }) as unknown as typeof fetch;
  const client = llmClient({ env, fetch: send, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; }, onCall: (c) => calls.push(c) });
  return { client, sent, waits, calls };
}

test("asks for a strict JSON-schema answer at the model's provider, with only that provider's key", async () => {
  const { client, sent } = fake([() => completion('{"ok":true}'), () => completion('{"ok":false}')]);
  const groq = await client.chat(ask("groq/gpt-oss-120b"));
  assert.deepEqual(groq.json, { ok: true });
  assert.equal(sent[0]!.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(sent[0]!.headers.Authorization, "Bearer gsk_test_groq");
  assert.deepEqual(sent[0]!.body.response_format, { type: "json_schema", json_schema: { name: "probe", schema: SCHEMA, strict: true } });
  assert.equal(sent[0]!.body.model, "openai/gpt-oss-120b");
  assert.equal(sent[0]!.body.reasoning_effort, "low");

  await client.chat(ask("gemini/3.5-flash-lite"));
  assert.equal(sent[1]!.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(sent[1]!.headers.Authorization, "Bearer gemini_test_key");
  assert.equal(sent[1]!.body.model, "gemini-3.5-flash-lite");
  assert.ok(!JSON.stringify(sent[1]).includes("gsk_test_groq"), "the Groq key never goes to Google");
});

test("reads the usage, cached input included, and keeps an answer that isn't JSON as text", async () => {
  const usage = { prompt_tokens: 3000, completion_tokens: 400, total_tokens: 3400, prompt_tokens_details: { cached_tokens: 1000 } };
  const { client } = fake([() => completion('{"ok":true}', usage), () => completion('{"ok":', undefined, "length")]);
  assert.deepEqual((await client.chat(ask("groq/gpt-oss-20b"))).usage, { input: 3000, cached: 1000, output: 400, total: 3400 });
  const cut = await client.chat(ask("groq/gpt-oss-20b"));
  assert.equal(cut.json, undefined);
  assert.equal(cut.text, '{"ok":');
  assert.equal(cut.finishReason, "length");
});

test("a 429 waits as long as the provider asks, in Groq's header or Gemini's body, then retries", async () => {
  const groq429 = () => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { "retry-after": "7" } });
  const gemini429 = () => new Response('[{"error":{"code":429,"message":"Quota exceeded","details":[{"retryDelay":"12.5s"}]}}]', { status: 429 });
  const { client, waits, calls } = fake([groq429, () => completion('{"ok":true}'), gemini429, () => completion('{"ok":true}')]);
  const groq = await client.chat(ask("groq/gpt-oss-20b"));
  assert.deepEqual([groq.attempts, groq.rateLimited], [2, 1]);
  await client.chat(ask("gemini/3.1-flash-lite"));
  assert.deepEqual(waits.filter((ms) => ms > 0), [7000, 12_500]);
  assert.deepEqual(calls.map((c) => [c.model, c.ok, c.attempts, c.rateLimited]), [["groq/gpt-oss-20b", true, 2, 1], ["gemini/3.1-flash-lite", true, 2, 1]]);
});

test("a refusal isn't retried, and a 429 asking for more than a minute (a daily cap) fails at once", async () => {
  const bad = () => new Response('{"error":{"message":"response_format: schema invalid in organization `org_01abcXYZ`"}}', { status: 400 });
  const daily = () => new Response('{"error":{"message":"tokens per day exceeded"}}', { status: 429, headers: { "retry-after": "3600" } });
  const { client, calls, waits } = fake([bad, daily]);
  await assert.rejects(client.chat(ask("groq/gpt-oss-120b")), (e) => e instanceof LlmError && e.status === 400 && /schema invalid/.test(e.message)
    && !e.message.includes("org_01abcXYZ"), "the account's organization ID stays out of errors");
  await assert.rejects(client.chat(ask("gemini/3.5-flash-lite")), (e) => e instanceof LlmError && e.status === 429);
  assert.deepEqual(calls.map((c) => [c.ok, c.attempts]), [[false, 1], [false, 1]], "each failure is logged as one request");
  assert.ok(waits.every((ms) => ms < 60_000), "never waited out the daily cap");
});

test("calls to one model are spaced by its per-minute limits; another model doesn't wait", async () => {
  const usage = { prompt_tokens: 3000, completion_tokens: 1000, total_tokens: 4000 };
  const { client, waits } = fake([() => completion("{}", usage), () => completion("{}", usage), () => completion("{}", usage)]);
  await client.chat(ask("groq/gpt-oss-120b"));
  await client.chat(ask("gemini/3.5-flash-lite"));
  assert.deepEqual(waits, [0, 0], "first calls go at once");
  await client.chat(ask("groq/gpt-oss-120b"));
  assert.equal(waits[2], 30_000, "4,000 tokens of Groq's 8,000 a minute: half a minute after the first call started");
});

test("a missing key fails before anything is sent, naming the variable", async () => {
  const sent: string[] = [];
  const client = llmClient({ env: { GROQ_API_KEY: "gsk_x" }, fetch: (async (url: URL) => { sent.push(url.href); return completion("{}"); }) as unknown as typeof fetch });
  await assert.rejects(client.chat(ask("gemini/3.5-flash-lite")), (e) => e instanceof ConfigError && /GEMINI_API_KEY is missing/.test(e.message));
  assert.deepEqual(sent, []);
});
