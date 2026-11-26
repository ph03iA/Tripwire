import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallEntry } from "./client.js";
import { type ModelSpec, PROVIDERS } from "./models.js";

/** Append-only log of every LLM call, by llm-check and runs alike. The free quotas are daily, so it's read per model per day. */
export const LLM_USAGE_LOG = fileURLToPath(new URL("../../../../runs/llm-usage.jsonl", import.meta.url));

export type LoggedCall = CallEntry & { source: string }; // source: "llm-check", or the run's ID
export type DayUse = { requests: number; tokens: number };

const DAY_MS = 24 * 3_600_000;
const pacificDate = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

export function logCall(entry: LoggedCall, file = LLM_USAGE_LOG) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

/** Whether a call made at `at` counts toward the model's quota day as of `now`. */
export function inQuotaDay(at: string, model: ModelSpec, now: number): boolean {
  const ms = Date.parse(at);
  return PROVIDERS[model.provider].day === "rolling" ? now - ms < DAY_MS : pacificDate(ms) === pacificDate(now);
}

/** Requests and tokens the model has used in its quota day. Tokens count as Groq counts them: cached input is free. */
export function usedToday(model: ModelSpec, now = Date.now(), file = LLM_USAGE_LOG): DayUse {
  const used: DayUse = { requests: 0, tokens: 0 };
  if (!existsSync(file)) return used;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const call = JSON.parse(line) as LoggedCall;
    if (call.model !== model.name || !inQuotaDay(call.at, model, now)) continue;
    used.requests += call.attempts;
    used.tokens += call.tokens.total - call.tokens.cached;
  }
  return used;
}

/** Why the model can't take `needed` more today, or null when it fits: the daily guard, like the Meko quota's (PRD R7). */
export function overBudget(model: ModelSpec, used: DayUse, needed: DayUse): string | null {
  const { rpd, tpd } = model.limits;
  if (used.requests + needed.requests > rpd) return `${model.name}: ${used.requests} requests used today + ${needed.requests} needed > ${rpd} a day`;
  if (tpd !== undefined && used.tokens + needed.tokens > tpd) return `${model.name}: ${used.tokens} tokens used today + ${needed.tokens} needed > ${tpd} a day`;
  return null;
}
