// CLI: npm run replay -- [--seed 42] [--meko off|dry|on] [--out runs]
//   off  no Meko calls at all (PRD R4)
//   dry  the whole ON pipeline against an in-process stand-in for Meko: counts the calls a live run would make
//   on   the real Meko account. It runs the dry pass first and refuses to start when that estimate, with headroom,
//        breaks the per-run ceiling (PRD §9) or doesn't fit what's left of this month's quota (R7). Spends real quota.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mekoConfig } from "../config.js";
import { generate } from "../generator/generate.js";
import { knowledgeDocuments, PATTERNS_DATAPACK } from "../knowledge/upload.js";
import { dryDocuments, dryMeko } from "../meko/dry.js";
import { connectMcp } from "../meko/mcp.js";
import { findDatapack, restClient } from "../meko/rest.js";
import { formatMetrics } from "../metrics.js";
import { SIGNALS_DATAPACK } from "../signals/meko.js";
import { lockDatapack } from "./lock.js";
import { logUsage, overCeiling, overQuota, preflight, usageOf, usedThisMonth, withHeadroom } from "./quota.js";
import { type MekoRun, replayStream, type RunRecord, type Stream } from "./replay.js";

const { values } = parseArgs({
  options: { seed: { type: "string", default: "42" }, meko: { type: "string", default: "off" }, out: { type: "string" } },
});
const RUNS: Record<string, (stream: Stream) => Promise<RunRecord>> = { off: (stream) => replayStream(stream), dry: dryRun, on: liveRun };
const runMode = RUNS[values.meko ?? "off"];
if (!runMode) {
  console.error(`--meko must be off, dry or on, not ${values.meko}`);
  process.exit(2);
}

const seed = Number(values.seed);
const record = await runMode({ seed, ...generate(seed) }); // a bad seed throws a RangeError before anything runs
report(record, save(record));
if (record.status === "failed") {
  console.error(`run failed: ${record.error}`);
  process.exit(1);
}

function dryMode(): MekoRun {
  return { mode: "dry", mcp: dryMeko(), datapacks: { signals: "dry-signals", patterns: "dry-patterns" }, documents: dryDocuments(), wait: async () => {} };
}

async function dryRun(stream: Stream): Promise<RunRecord> {
  const dry = await replayStream(stream, dryMode());
  const needs = usageOf(dry.mekoCalls ?? {});
  const used = usedThisMonth();
  const over = [...overCeiling(needs), ...overQuota(used, withHeadroom(needs))];
  console.log(`dry run: a live run would make ${JSON.stringify(needs)}`);
  console.log(`  calls by tool ${JSON.stringify(dry.mekoCalls)}`);
  console.log(over.length ? `  a live run would be refused: ${over.join("; ")}` : `  it fits the per-run ceiling and this month's quota, with headroom (used so far ${JSON.stringify(used)})`);
  return dry;
}

async function liveRun(stream: Stream): Promise<RunRecord> {
  const estimate = await replayStream(stream, dryMode());
  if (estimate.status !== "ok") throw new Error(`the dry pass failed, so the live run didn't start: ${estimate.error}`);
  const needed = withHeadroom(usageOf(estimate.mekoCalls ?? {}));
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
    return await onMeko(stream, { mode: "on", mcp: await connectMcp(cfg), datapacks, documents, progress: (line) => console.log(`  ${line}`) }, needed);
  } finally {
    release();
  }
}

async function onMeko(stream: Stream, run: MekoRun, needed: ReturnType<typeof usageOf>): Promise<RunRecord> {
  console.log(`live ON run, estimated with headroom at ${JSON.stringify(needed)}. One line per simulated day:`);
  const ranAt = new Date().toISOString();
  let runId = "unknown";
  try {
    const live = await replayStream(stream, run);
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
  if (r.metrics) console.log(formatMetrics(r.metrics));
}

/** The ON-only lines: the R8 audit, quotes that couldn't be found, and the Meko calls. */
function reportMeko(r: RunRecord) {
  if (r.audit) console.log(r.audit.passed ? `hygiene audit passed: kept ${r.audit.kept} signals, deleted ${r.audit.deleted} other memories`
    : `hygiene audit FAILED: ${r.audit.error}`);
  const unquoted = r.decisions.filter((d) => d.missingQuotes?.length).length;
  if (unquoted) console.log(`${unquoted} STEP-UPs or BLOCKs are missing a required playbook or policy passage (see missingQuotes)`);
  if (r.mekoCalls) console.log(`Meko calls ${JSON.stringify(r.mekoCalls)}; case conversations ${Object.keys(r.conversations?.cases ?? {}).length}`);
}
