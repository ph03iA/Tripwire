import { llmKey, USER_AGENT } from "../config.js";
import { HttpError, retryAfterMs, type Wait, withRetry } from "../meko/retry.js";
import { type ModelSpec, PROVIDERS } from "./models.js";

const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 4_096; // reasoning tokens count against this too

export class LlmError extends HttpError {
  override name = "LlmError";
}

export type JsonSchema = Record<string, unknown>;
export type ChatRequest = { model: ModelSpec; system: string; user: string; schemaName: string; schema: JsonSchema; maxTokens?: number };
export type TokenUsage = { input: number; cached: number; output: number; total: number };
export type ChatAnswer = {
  json: unknown; // the parsed answer; undefined when it isn't JSON (cut off, say)
  text: string;
  finishReason: string;
  usage: TokenUsage;
  ms: number;
  attempts: number;
  rateLimited: number; // attempts refused with a 429
};
/** One chat call, for the usage log: every attempt counts as a request, even a refused one. */
export type CallEntry = { at: string; model: string; ok: boolean; attempts: number; rateLimited: number; tokens: TokenUsage };

export type LlmClient = { chat(req: ChatRequest): Promise<ChatAnswer> };
export type LlmOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  wait?: Wait;
  now?: () => number;
  onCall?: (entry: CallEntry) => void;
};

const NONE: TokenUsage = { input: 0, cached: 0, output: 0, total: 0 };
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chat completions with a strict JSON-schema answer, on Groq or Gemini. Each provider's key goes only to its own URL.
 * Calls to one model are spaced to stay under its per-minute limits, and a 429 or 5xx is retried per meko/retry.ts.
 */
export function llmClient({ env, fetch: send = fetch, wait = sleep, now = Date.now, onCall }: LlmOptions = {}): LlmClient {
  const nextAt = new Map<string, number>(); // model name → earliest start of its next call
  return {
    chat: async (req) => {
      const { model } = req;
      const key = llmKey(PROVIDERS[model.provider].keyVar, env);
      await wait(Math.max(0, (nextAt.get(model.name) ?? 0) - now()));
      const started = now();
      const tally = { attempts: 0, rateLimited: 0 };
      let answer: Omit<ChatAnswer, "ms" | "attempts" | "rateLimited"> | undefined;
      try {
        answer = await withRetry(`${model.name} chat`, "read", () => attempt(send, key, req, tally), wait);
        return { ...answer, ms: now() - started, ...tally };
      } finally {
        nextAt.set(model.name, started + gapMs(model, answer?.usage));
        onCall?.({ at: new Date(started).toISOString(), model: model.name, ok: answer !== undefined, ...tally, tokens: answer?.usage ?? NONE });
      }
    },
  };
}

async function attempt(send: typeof fetch, key: string, req: ChatRequest, tally: { attempts: number; rateLimited: number }) {
  tally.attempts++;
  try {
    const res = await send(new URL("chat/completions", PROVIDERS[req.model.provider].baseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(bodyOf(req)),
    });
    return await answerOf(res, req.model);
  } catch (err) {
    if (err instanceof LlmError && err.status === 429) tally.rateLimited++;
    throw err;
  }
}

const bodyOf = ({ model, system, user, schemaName, schema, maxTokens }: ChatRequest) => ({
  model: model.id,
  messages: [{ role: "system", content: system }, { role: "user", content: user }],
  response_format: { type: "json_schema", json_schema: { name: schemaName, schema, strict: true } },
  max_tokens: maxTokens ?? MAX_TOKENS,
  ...model.params,
});

type Completion = {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

async function answerOf(res: Response, model: ModelSpec) {
  const text = await res.text();
  if (!res.ok) throw new LlmError(`${model.name}: HTTP ${res.status}: ${errorMessage(text)}`, res.status, retryAfterMs(res) ?? retryDelayMs(text));
  const body = parseJson(text) as Completion | undefined;
  const choice = body?.choices?.[0];
  if (!body || !choice) throw new LlmError(`${model.name}: the response has no answer: ${text.slice(0, 160)}`);
  const content = choice.message?.content ?? "";
  return { json: parseJson(content), text: content, finishReason: choice.finish_reason ?? "unknown", usage: usageOf(body) };
}

function usageOf({ usage: u }: Completion): TokenUsage {
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  return { input, cached: u?.prompt_tokens_details?.cached_tokens ?? 0, output, total: u?.total_tokens ?? input + output };
}

/** The gap before the model's next call: one request's share of a minute, or the share its tokens took of the token limit. */
function gapMs(model: ModelSpec, usage: TokenUsage | undefined): number {
  const counted = !usage ? 0 : PROVIDERS[model.provider].tpmCounts === "input" ? usage.input : usage.total - usage.cached;
  return Math.ceil(60_000 * Math.max(1 / model.limits.rpm, counted / model.limits.tpm));
}

/**
 * Groq answers `{ error: { message } }`; Gemini's compatibility layer may wrap the same in a list. Groq's messages name
 * the account's organization ID, which is left out, since errors end up in run records and traces.
 */
function errorMessage(text: string): string {
  const json = parseJson(text);
  const error = (Array.isArray(json) ? json[0] : json) as { error?: { message?: unknown } } | undefined;
  const message = typeof error?.error?.message === "string" ? error.error.message.slice(0, 300) : text.slice(0, 160);
  return message.replace(/org_[A-Za-z0-9]+/g, "org_…");
}

/** Gemini states its wait in the body, as google.rpc.RetryInfo's `"retryDelay": "37s"`. */
function retryDelayMs(text: string): number | undefined {
  const seconds = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text)?.[1];
  return seconds ? Math.ceil(Number(seconds) * 1000) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
