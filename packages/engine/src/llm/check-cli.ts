import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Action } from "../agents/decision.js";
import { ConfigError, llmKey } from "../config.js";
import { logCall, overBudget, usedToday } from "./budget.js";
import { type BatchSample, checkBatch, checkDecision, type DecisionSample, type Prompt, promptFor, type Sample, samples } from "./check.js";
import { type ChatAnswer, type LlmClient, llmClient, type TokenUsage } from "./client.js";
import { MODELS, modelNamed, type ModelSpec, PROVIDERS } from "./models.js";

/**
 * npm run llm-check [-- --models groq/gpt-oss-120b,gemini/3.5-flash-lite]
 * Sends the same batch reviews and decisions to each candidate model and reports, per model: valid answers, 429s,
 * time, tokens, and how the answers compare with the labels and with the rules. Spends free-tier quota only.
 */
const RUNS = fileURLToPath(new URL("../../../../runs/", import.meta.url));
const OUTPUT_ALLOWANCE = 1_500; // tokens a call may answer with, for the budget check only

type Result = {
  sample: string; ok: boolean; error?: string; ms?: number; usage?: TokenUsage; rateLimited?: number; finishReason?: string;
  problems: string[]; flagged?: string[]; action?: Action; answer?: unknown;
};
type ModelRun = { model: string; skipped?: string; results: Result[] };

const argValue = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const estimate = (p: Prompt) => Math.ceil((p.system.length + p.user.length + JSON.stringify(p.schema).length) / 3) + OUTPUT_ALLOWANCE;

async function main() {
  const models = (argValue("--models")?.split(",") ?? MODELS.map((m) => m.name)).map(modelNamed);
  console.log("Building the test calls from a seed-42 OFF run…");
  const all = await samples(42);
  const prompts = all.map(promptFor);
  const needed = { requests: all.length, tokens: prompts.reduce((n, p) => n + estimate(p), 0) };
  console.log(`${all.length} calls per model (${all.filter((s) => s.kind === "batch").length} batch reviews), about ${needed.tokens} tokens each at most.`);
  const client = llmClient({ onCall: (entry) => logCall({ ...entry, source: "llm-check" }) });
  const runs = await Promise.all(models.map((m) => checkModel(client, m, all, prompts, needed)));
  report(all, runs);
  const file = `${RUNS}llm-check-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), samples: all.map(sampleInfo), runs }, null, 1));
  console.log(`\nEvery answer: ${file}`);
}

async function checkModel(client: LlmClient, model: ModelSpec, all: Sample[], prompts: Prompt[], needed: { requests: number; tokens: number }): Promise<ModelRun> {
  const unusable = keyProblem(model) ?? overBudget(model, usedToday(model), needed);
  if (unusable) return { model: model.name, skipped: unusable, results: [] };
  const results: Result[] = [];
  for (const [i, s] of all.entries()) {
    const r = await callOne(client, model, s, prompts[i]!);
    console.log(`${model.name} ${s.id}: ${r.ok ? `${r.ms} ms, ${r.problems.length ? r.problems[0] : "valid"}` : r.error}`);
    results.push(r);
  }
  return { model: model.name, results };
}

function keyProblem(model: ModelSpec): string | null {
  try {
    llmKey(PROVIDERS[model.provider].keyVar);
    return null;
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
}

async function callOne(client: LlmClient, model: ModelSpec, s: Sample, prompt: Prompt): Promise<Result> {
  try {
    const a = await client.chat({ model, ...prompt });
    return { sample: s.id, ok: true, ms: a.ms, usage: a.usage, rateLimited: a.rateLimited, finishReason: a.finishReason, answer: a.json ?? a.text, ...judge(s, a) };
  } catch (err) {
    return { sample: s.id, ok: false, error: err instanceof Error ? err.message : String(err), problems: [] };
  }
}

function judge(s: Sample, a: ChatAnswer): Pick<Result, "problems" | "flagged" | "action"> {
  if (a.json === undefined) return { problems: [`the answer isn't JSON (finish reason: ${a.finishReason})`] };
  return s.kind === "batch" ? checkBatch(a.json, s) : checkDecision(a.json, s);
}

/** One row per model, plus the rules on the same calls, then the distinct errors. */
function report(all: Sample[], runs: ModelRun[]) {
  const batches = all.filter((s): s is BatchSample => s.kind === "batch");
  const decisions = all.filter((s): s is DecisionSample => s.kind === "decision");
  console.log("\n| model | answered | valid | 429s | batch: attacks flagged | batch: legit flagged | decisions: attacks stopped | legit ALLOW / STEP-UP / BLOCK | tokens per batch call | per decision | median time |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  console.log(`| rules | – | – | – | ${batchScore(batches, (s) => s.ruleFlags)} | ${legitFlagged(batches, (s) => s.ruleFlags)} | ${stopped(decisions, (s) => s.rulesAction)} | ${legitActions(decisions, (s) => s.rulesAction)} | – | – | – |`);
  for (const run of runs) console.log(run.skipped ? `| ${run.model} | skipped: ${run.skipped} |` : row(run, batches, decisions));
  for (const run of runs) {
    const errors = [...new Set(run.results.flatMap((r) => (r.error ? [r.error] : r.problems)))];
    if (errors.length) console.log(`\n${run.model}:\n${errors.slice(0, 5).map((e) => `- ${e}`).join("\n")}`);
  }
}

function row(run: ModelRun, batches: BatchSample[], decisions: DecisionSample[]): string {
  const by = new Map(run.results.map((r) => [r.sample, r]));
  const flags = (s: BatchSample) => by.get(s.id)?.flagged ?? [];
  const action = (s: DecisionSample) => by.get(s.id)?.action;
  const ok = run.results.filter((r) => r.ok);
  const valid = ok.filter((r) => r.problems.length === 0).length;
  const rateLimited = ok.reduce((n, r) => n + (r.rateLimited ?? 0), 0) + run.results.filter((r) => r.error?.includes("HTTP 429")).length;
  const ms = ok.map((r) => r.ms!).sort((a, b) => a - b);
  const median = ms.length ? `${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)} s` : "–";
  return `| ${run.model} | ${ok.length}/${run.results.length} | ${valid} | ${rateLimited} | ${batchScore(batches, flags)} | ${legitFlagged(batches, flags)} | `
    + `${stopped(decisions, action)} | ${legitActions(decisions, action)} | ${tokens(ok, "batch:")} | ${tokens(ok, "decision:")} | ${median} |`;
}

function batchScore(batches: BatchSample[], flags: (s: BatchSample) => string[]): string {
  const hit = batches.reduce((n, s) => n + s.attacks.filter((id) => flags(s).includes(id)).length, 0);
  return `${hit}/${batches.reduce((n, s) => n + s.attacks.length, 0)}`;
}

function legitFlagged(batches: BatchSample[], flags: (s: BatchSample) => string[]): string {
  const wrong = batches.reduce((n, s) => n + flags(s).filter((id) => !s.attacks.includes(id)).length, 0);
  return `${wrong}/${batches.reduce((n, s) => n + s.events.length - s.attacks.length, 0)}`;
}

const stopped = (ds: DecisionSample[], action: (s: DecisionSample) => Action | undefined) =>
  `${ds.filter((s) => s.attack && (action(s) === "STEP_UP" || action(s) === "BLOCK")).length}/${ds.filter((s) => s.attack).length}`;

function legitActions(ds: DecisionSample[], action: (s: DecisionSample) => Action | undefined): string {
  const legit = ds.filter((s) => !s.attack);
  return (["ALLOW", "STEP_UP", "BLOCK"] as const).map((a) => legit.filter((s) => action(s) === a).length).join(" / ");
}

function tokens(results: Result[], prefix: string): string {
  const own = results.filter((r) => r.sample.startsWith(prefix) && r.usage);
  if (!own.length) return "–";
  const avg = (pick: (u: TokenUsage) => number) => Math.round(own.reduce((n, r) => n + pick(r.usage!), 0) / own.length);
  return `${avg((u) => u.input)} in / ${avg((u) => u.output)} out`;
}

const sampleInfo = (s: Sample) => (s.kind === "batch"
  ? { id: s.id, events: s.events.length, attacks: s.attacks, ruleFlags: s.ruleFlags }
  : { id: s.id, attack: s.attack, chain: s.chain ?? null, rulesAction: s.rulesAction, signals: s.signals.length });

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
