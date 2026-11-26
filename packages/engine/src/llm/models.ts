/** The two free-tier providers. Both speak the OpenAI chat-completions format. */
export type Provider = "groq" | "gemini";

type ProviderSpec = {
  baseUrl: string; // the key is only ever sent under this URL
  keyVar: string; // the .env variable that holds the key
  /** When a day's quota resets: Gemini at midnight Pacific; Groq doesn't say, so a rolling 24 h window to be safe. */
  day: "pacific" | "rolling";
  /** What the per-minute token limit counts: Gemini counts input only; Groq counts all, except cached input. */
  tpmCounts: "input" | "total";
};

export const PROVIDERS: Record<Provider, ProviderSpec> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1/", keyVar: "GROQ_API_KEY", day: "rolling", tpmCounts: "total" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", keyVar: "GEMINI_API_KEY", day: "pacific", tpmCounts: "input" },
};

/** Free-tier limits: requests and tokens a minute, requests a day, and tokens a day where the provider caps them. */
export type Limits = { rpm: number; tpm: number; rpd: number; tpd?: number };

export type ModelSpec = {
  name: string; // what logs, reports and agent lists call it
  provider: Provider;
  id: string; // the provider's model ID
  limits: Limits;
  params: Record<string, unknown>; // extra request fields: reasoning effort, temperature, seed
  maxTokens: number; // reasoning tokens count against it too
};

const GROQ_FREE: Limits = { rpm: 30, tpm: 8_000, rpd: 1_000, tpd: 200_000 }; // Groq's rate-limits page, 2026-11-27
const GEMINI_FLASH_LITE_FREE: Limits = { rpm: 15, tpm: 250_000, rpd: 500 }; // the project's AI Studio rate-limit page, 2026-11-27
const GROQ_PARAMS = { temperature: 0, seed: 42, reasoning_effort: "low" };
const GROQ_MAX_TOKENS = 4_096;
// Gemini 3.1 Flash-Lite ran past 4,096 on a 50-event review (llm-check, 2026-11-27); output is free and uncapped per minute.
const GEMINI_MAX_TOKENS = 8_192;

/** The candidates `npm run llm-check` measures. Providers retire models now and then, so the IDs live only here. */
export const MODELS: ModelSpec[] = [
  { name: "groq/gpt-oss-120b", provider: "groq", id: "openai/gpt-oss-120b", limits: GROQ_FREE, params: GROQ_PARAMS, maxTokens: GROQ_MAX_TOKENS },
  { name: "groq/gpt-oss-20b", provider: "groq", id: "openai/gpt-oss-20b", limits: GROQ_FREE, params: GROQ_PARAMS, maxTokens: GROQ_MAX_TOKENS },
  // Left out: qwen/qwen3.8-27b. On this account Groq caps it at 7,000 input and 1,000 output tokens a minute, so it
  // refused 2 of the 4 batch reviews and all 7 decisions (llm-check, 2026-11-27).
  // No temperature or seed: Google's defaults, until llm-check gives a reason to change them.
  { name: "gemini/3.5-flash-lite", provider: "gemini", id: "gemini-3.5-flash-lite", limits: GEMINI_FLASH_LITE_FREE, params: { reasoning_effort: "low" }, maxTokens: GEMINI_MAX_TOKENS },
  { name: "gemini/3.1-flash-lite", provider: "gemini", id: "gemini-3.1-flash-lite", limits: GEMINI_FLASH_LITE_FREE, params: { reasoning_effort: "low" }, maxTokens: GEMINI_MAX_TOKENS },
];

/**
 * The detection agents' models, in order, chosen from llm-check on 2026-11-27: with pattern readings, 3.5 Flash-Lite
 * flagged all of s1's spray and nothing legit; 3.1 Flash-Lite caught it with more noise; gpt-oss-20b caught it in one
 * batch. A model that's out of quota or failing hands over to the next; after the last, the rules' signals stand alone.
 */
export const DETECTION_MODELS = ["gemini/3.5-flash-lite", "gemini/3.1-flash-lite", "groq/gpt-oss-20b"];

export function modelNamed(name: string): ModelSpec {
  const model = MODELS.find((m) => m.name === name);
  if (!model) throw new Error(`no model named ${name}: the known ones are ${MODELS.map((m) => m.name).join(", ")}`);
  return model;
}
