import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Append-only logs of what every ON run and spike check sent, retries included. K8 matched these to the portal's Usage page exactly. */
export const QUOTA_LOG = fileURLToPath(new URL("../../../../runs/quota.jsonl", import.meta.url));
export const SPIKE_LOG = fileURLToPath(new URL("../../../../runs/spike/attempts.jsonl", import.meta.url));

/** The three monthly counters Meko caps on the Free plan (K8). conversation_create and memory_get_all aren't counted. */
export type Usage = { conversationMessages: number; memorySearches: number; kbSearches: number };
// shortcut: the Free plan's limits, and a reset on the 1st of each UTC month, since the real reset day is unknown (K8);
// change both once the plan changes or the day is known.
export const FREE: Usage = { conversationMessages: 1000, memorySearches: 1000, kbSearches: 1000 };
/** PRD §9: what one ON run may spend. */
export const CEILING = { conversationMessages: 120, searches: 800 };
/** The dry run's search is ideal, while a live one repeats a search that misses a fresh signal (A7), so the estimate gets headroom. */
export const HEADROOM = 1.25;

const COUNTED: Record<string, keyof Usage> = {
  conversation_add_message: "conversationMessages",
  memory_search: "memorySearches",
  knowledgebase_search: "kbSearches",
};

export function usageOf(calls: Record<string, number>): Usage {
  const usage: Usage = { conversationMessages: 0, memorySearches: 0, kbSearches: 0 };
  for (const [tool, n] of Object.entries(calls)) if (COUNTED[tool]) usage[COUNTED[tool]] += n;
  return usage;
}

/** What this month's lines in the logs add up to. Lines are `{ ranAt, mcp: { tool: attempts } }`, written by the runner and the spike. */
export function usedThisMonth(month = new Date().toISOString().slice(0, 7), files = [QUOTA_LOG, SPIKE_LOG]): Usage {
  const total = usageOf({});
  for (const file of files.filter(existsSync)) {
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as { ranAt?: string; mcp?: Record<string, number> };
      if (!entry.ranAt?.startsWith(month)) continue;
      const used = usageOf(entry.mcp ?? {});
      for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += used[k];
    }
  }
  return total;
}

/** Why a run needing `needed` doesn't fit what's left this month, one sentence per counter; empty when it fits (PRD R7). */
export function overQuota(used: Usage, needed: Usage, limits = FREE): string[] {
  return (Object.keys(limits) as (keyof Usage)[]).flatMap((k) =>
    used[k] + needed[k] > limits[k] ? [`${k}: ${used[k]} used this month + ${needed[k]} needed > ${limits[k]}`] : []);
}

/** Whether one run stays inside PRD §9's ceiling, in words. */
export const ceilingCheck = (u: Usage) =>
  u.conversationMessages <= CEILING.conversationMessages && u.memorySearches + u.kbSearches <= CEILING.searches
    ? `within the per-run ceiling (${CEILING.conversationMessages} conversation messages, ${CEILING.searches} searches)`
    : `over the per-run ceiling (${CEILING.conversationMessages} conversation messages, ${CEILING.searches} searches)`;

export const withHeadroom = (u: Usage): Usage => ({
  conversationMessages: Math.ceil(u.conversationMessages * HEADROOM),
  memorySearches: Math.ceil(u.memorySearches * HEADROOM),
  kbSearches: Math.ceil(u.kbSearches * HEADROOM),
});

export function logUsage(entry: { ranAt: string; runId: string; mcp: Record<string, number> }, file = QUOTA_LOG) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n");
}
