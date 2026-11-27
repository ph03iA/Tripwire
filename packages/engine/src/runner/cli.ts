// CLI: npm run replay -- [--seed 42] [--meko off|dry|on] [--agents rules|llm] [--out runs]
//   off  no Meko calls at all (PRD R4)
//   dry  the whole ON pipeline against an in-process stand-in for Meko: counts the calls a live run would make
//   on   the real Meko account. It runs the dry pass first and refuses to start when that estimate, with headroom,
//        breaks the per-run ceiling (PRD §9) or doesn't fit what's left of this month's quota (R7). Spends real quota.
//   --agents llm  the AI agents (M2.5): the detection agents' models also review every event, on top of the rules, and
//        the decision agent's model decides within the guardrails. It counts the model calls first and refuses to start
//        when today's free quota can't hold them. Spends Groq and Gemini free quota.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mekoConfig } from "../config.js";
import { generate } from "../generator/generate.js";
import { logCall, usedToday } from "../llm/budget.js";
import { llmClient } from "../llm/client.js";
import { DECISION_MODELS, DETECTION_MODELS, modelNamed, type ModelSpec } from "../llm/models.js";
import { knowledgeDocuments, PATTERNS_DATAPACK } from "../knowledge/upload.js";
import { dryDocuments, dryMeko } from "../meko/dry.js";
import { connectMcp } from "../meko/mcp.js";
import { findDatapack, restClient } from "../meko/rest.js";
import { formatMetrics } from "../metrics.js";
import { SIGNALS_DATAPACK } from "../signals/meko.js";
import { lockDatapack } from "./lock.js";
import { logUsage, overCeiling, overQuota, preflight, usageOf, usedThisMonth, withHeadroom } from "./quota.js";
import { type AiRun, type MekoRun, replayStream, type RunRecord, type Stream } from "./replay.js";
import { llmDecider, localKnowledge } from "./decider.js";
import { llmReviewer, type Review, silentReviewer } from "./review.js";

const { values } = parseArgs({
  options: { seed: { type: "string", default: "42" }, meko: { type: "string", default: "off" }, agents: { type: "string", default: "rules" }, out: { type: "string" } },
});
const RUNS: Record<string, (stream: Stream, ai?: AiRun) => Promise<RunRecord>> = { off: (stream, ai) => replayStream(stream, undefined, ai), dry: dryRun, on: liveRun };
const runMode = RUNS[values.meko ?? "off"];
if (!runMode || !["rules", "llm"].includes(values.agents ?? "rules")) {
  console.error(`--meko must be off, dry or on, and --agents rules or llm, not ${values.meko} and ${values.agents}`);
  process.exit(2);
}

const seed = Number(values.seed);
const stream: Stream = { seed, ...generate(seed) }; // a bad seed throws a RangeError before anything runs
const record = await runMode(stream, values.agents === "llm" ? await aiRun(stream) : undefined);
report(record, save(record));
if (record.status === "failed") {
  console.error(`run failed: ${record.error}`);
  process.exit(1);
}

function dryMode(): MekoRun {
  return { mode: "dry", mcp: dryMeko(), datapacks: { signals: "dry-signals", patterns: "dry-patterns" }, documents: dryDocuments(), wait: async () => {} };
}

/**
 * The AI agents' models, after a check that today's free quota holds the run: a pass that calls no model counts the
 * batch reviews and the decisions with evidence first. A decision may take two calls (need_more), so it counts twice.
 */
async function aiRun(stream: Stream): Promise<AiRun> {
  const detection = DETECTION_MODELS.map(modelNamed);
  const deciding = DECISION_MODELS.map(modelNamed);
  const count = await replayStream(stream, undefined, { reviewer: silentReviewer });
  const reviews = count.reviews?.length ?? 0;
  const judgments = 2 * withEvidence(count);
  const everyModel = [...new Set([...detection, ...deciding])];
  console.log(`AI agents: about ${reviews} batch reviews and up to ${judgments} decision calls. `
    + `Requests left today: ${everyModel.map((m) => `${m.name} ${requestsLeft([m])}`).join(", ")}`);
  // shortcut: a model on both lists counts for each, so two short lists can each look sufficient; per-model accounting if that bites.
  if (requestsLeft(detection) < reviews || requestsLeft(deciding) < judgments) {
    console.error("refused: today's free quota can't hold this run's model calls.");
    process.exit(2);
  }
  const client = llmClient({ onCall: (entry) => logCall({ ...entry, source: `replay seed ${stream.seed}` }) });
  return { reviewer: llmReviewer({ client, models: detection }), decider: llmDecider({ client, models: deciding, knowledge: localKnowledge() }) };
}

const requestsLeft = (models: ModelSpec[]) => models.reduce((n, m) => n + Math.max(0, m.limits.rpd - usedToday(m).requests), 0);
const withEvidence = (r: RunRecord) => r.decisions.filter((d) => d.signalsUsed.length > 0).length;

async function dryRun(stream: Stream, ai?: AiRun): Promise<RunRecord> {
  const dry = await replayStream(stream, dryMode(), ai);
  const needs = usageOf(dry.mekoCalls ?? {});
  const used = usedThisMonth();
  const over = [...overCeiling(needs), ...overQuota(used, withHeadroom(needs))];
  console.log(`dry run: a live run would make ${JSON.stringify(needs)}`);
  console.log(`  calls by tool ${JSON.stringify(dry.mekoCalls)}`);
  console.log(over.length ? `  a live run would be refused: ${over.join("; ")}` : `  it fits the per-run ceiling and this month's quota, with headroom (used so far ${JSON.stringify(used)})`);
  return dry;
}

async function liveRun(stream: Stream, ai?: AiRun): Promise<RunRecord> {
  const estimate = await replayStream(stream, dryMode(), ai && { reviewer: silentReviewer }); // counts Meko calls; spends no model quota
  if (estimate.status !== "ok") throw new Error(`the dry pass failed, so the live run didn't start: ${estimate.error}`);
  const usage = usageOf(estimate.mekoCalls ?? {});
  if (ai?.decider) usage.memorySearches += withEvidence(estimate); // at most one need_more search per model decision
  const needed = withHeadroom(usage);
  const refused = preflight(needed, usedThisMonth());
  if (refused.length) {
    console.error(`refused before connecting (R7, PRD §9): ${refused.join("; ")}.`);
    process.exit(2);
  }
  const cfg = mekoConfig();
  const rest = restClient(cfg);
  const datapacks = { signals: await findDatapack(rest, SIGNALS_DATAPACK), patterns: await findDatapack(rest, PATTERNS_DATAPACK) };
  const documents = await knowledgeDocuments(rest, datapacks.patterns);
  const release = lockDatapack(datapacks.signals, `seed ${stream.seed}`);
  try {
    return await onMeko(stream, { mode: "on", mcp: await connectMcp(cfg), datapacks, documents, progress: (line) => console.log(`  ${line}`) }, needed, ai);
  } finally {
    release();
  }
}

async function onMeko(stream: Stream, run: MekoRun, needed: ReturnType<typeof usageOf>, ai?: AiRun): Promise<RunRecord> {
  console.log(`live ON run, estimated with headroom at ${JSON.stringify(needed)}. One line per simulated day:`);
  const ranAt = new Date().toISOString();
  let runId = "unknown";
  try {
    const live = await replayStream(stream, run, ai);
    runId = live.runId;
    return live;
  } finally {
    logUsage({ ranAt, runId, mcp: Object.fromEntries(run.mcp.calls) }); // even for a failed run: Meko counted what was sent
    await run.mcp.close();
  }
}

function save(r: RunRecord): string {
  // npm runs this from packages/engine; resolve --out from where the user typed the command.
  const outDir = values.out ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out) : fileURLToPath(new URL("../../../../runs/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${r.runId}.json`);
  writeFileSync(file, JSON.stringify(r, null, 1) + "\n");
  return file;
}

function report(r: RunRecord, file: string) {
  const byType = new Map<string, number>();
  for (const s of r.signals) byType.set(`${s.agent}/${s.type}`, (byType.get(`${s.agent}/${s.type}`) ?? 0) + 1);
  console.log(`${r.status}: ${r.events} events, ${r.findings.length} findings, ${r.signals.length} signals → ${file}`);
  for (const [type, n] of [...byType].sort()) console.log(`  ${type.padEnd(36)} ${n}`);
  const actions = r.decisions.map((d) => d.action);
  console.log(`${r.decisions.length} decisions (${["BLOCK", "STEP_UP", "ALLOW"].map((a) => `${a} ${actions.filter((x) => x === a).length}`).join(", ")}), `
    + `refused after a stop: ${r.denied.length}`);
  reportMeko(r);
  reportAi(r);
  if (r.metrics) console.log(formatMetrics(r.metrics));
}

/** The llm-only lines: batch reviews by reason and model, what they added, and when the rules stood alone. */
function reportAi(r: RunRecord) {
  if (!r.reviews) return;
  const count = (key: (x: Review) => string) => JSON.stringify(Object.fromEntries(
    [...new Set(r.reviews!.map(key))].map((k) => [k, r.reviews!.filter((x) => key(x) === k).length])));
  const tokens = r.reviews.reduce((n, x) => ({ input: n.input + (x.tokens?.input ?? 0), output: n.output + (x.tokens?.output ?? 0) }), { input: 0, output: 0 });
  console.log(`AI reviews: ${r.reviews.length} batches ${count((x) => x.reason)}, by model ${count((x) => x.model ?? "none")}; `
    + `${r.reviews.reduce((n, x) => n + x.added, 0)} signals added; tokens ${tokens.input} in, ${tokens.output} out`);
  const fallbacks = r.reviews.filter((x) => x.fallback);
  if (fallbacks.length) console.log(`  ${fallbacks.length} batches kept the rules' signals only, e.g. ${fallbacks[0]!.fallback}`);
  reportDecisions(r);
}

/** Who decided, how often the model's decision differs from the rules', and the guardrails and searches behind them. */
function reportDecisions(r: RunRecord) {
  const judged = r.decisions.filter((d) => d.decidedBy);
  if (!judged.length) return;
  const by = Object.fromEntries([...new Set(judged.map((d) => d.decidedBy!))].map((m) => [m, judged.filter((d) => d.decidedBy === m).length]));
  const differ = judged.filter((d) => d.rules && d.rules.action !== d.action).length;
  console.log(`AI decisions: by ${JSON.stringify(by)}; ${differ} differ from the rules; ${judged.filter((d) => d.guardrails?.length).length} with a guardrail `
    + `or fallback; ${judged.filter((d) => d.needMore).length} asked for more evidence`);
}

/** The ON-only lines: the R8 audit, quotes that couldn't be found, and the Meko calls. */
function reportMeko(r: RunRecord) {
  if (r.audit) console.log(r.audit.passed ? `hygiene audit passed: kept ${r.audit.kept} signals, deleted ${r.audit.deleted} other memories`
    : `hygiene audit FAILED: ${r.audit.error}`);
  const unquoted = r.decisions.filter((d) => d.missingQuotes?.length).length;
  if (unquoted) console.log(`${unquoted} STEP-UPs or BLOCKs are missing a required playbook or policy passage (see missingQuotes)`);
  if (r.mekoCalls) console.log(`Meko calls ${JSON.stringify(r.mekoCalls)}; case conversations ${Object.keys(r.conversations?.cases ?? {}).length}`);
}
