// CLI: npm run replay -- [--seed 42] [--meko off|dry|on] [--out runs]
//   off  no Meko calls at all (PRD R4)
//   dry  the whole ON pipeline against an in-process stand-in for Meko: counts the calls a live run would make
//   on   the real Meko account. It runs the dry pass first and refuses to start when that estimate, with headroom,
//        doesn't fit what's left of this month's quota (R7). Spends real quota.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mekoConfig } from "../config.js";
import { generate } from "../generator/generate.js";
import { PATTERNS_DATAPACK } from "../knowledge/upload.js";
import { dryMeko } from "../meko/dry.js";
import { connectMcp } from "../meko/mcp.js";
import { findDatapack, restClient } from "../meko/rest.js";
import { formatMetrics } from "../metrics.js";
import { SIGNALS_DATAPACK } from "../signals/meko.js";
import { ceilingCheck, logUsage, overQuota, usageOf, usedThisMonth, withHeadroom } from "./quota.js";
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
  return { mode: "dry", mcp: dryMeko(), datapacks: { signals: "dry-signals", patterns: "dry-patterns" }, wait: async () => {} };
}

async function dryRun(stream: Stream): Promise<RunRecord> {
  const dry = await replayStream(stream, dryMode());
  const needs = usageOf(dry.mekoCalls ?? {});
  const used = usedThisMonth();
  const over = overQuota(used, withHeadroom(needs));
  console.log(`dry run: a live run would make ${JSON.stringify(needs)}, ${ceilingCheck(needs)}`);
  console.log(`  calls by tool ${JSON.stringify(dry.mekoCalls)}`);
  console.log(over.length ? `  it wouldn't fit this month's quota: ${over.join("; ")}` : `  it fits this month's quota, with headroom (used so far ${JSON.stringify(used)})`);
  return dry;
}

async function liveRun(stream: Stream): Promise<RunRecord> {
  const estimate = await replayStream(stream, dryMode());
  if (estimate.status !== "ok") throw new Error(`the dry pass failed, so the live run didn't start: ${estimate.error}`);
  const needed = withHeadroom(usageOf(estimate.mekoCalls ?? {}));
  const over = overQuota(usedThisMonth(), needed);
  if (over.length) {
    console.error(`refused (R7): this run could go over the Meko quota. ${over.join("; ")}. Wait for the reset or upgrade the plan.`);
    process.exit(2);
  }
  const cfg = mekoConfig();
  const rest = restClient(cfg);
  const datapacks = { signals: await findDatapack(rest, SIGNALS_DATAPACK), patterns: await findDatapack(rest, PATTERNS_DATAPACK) };
  const mcp = await connectMcp(cfg);
  console.log(`live ON run, estimated with headroom at ${JSON.stringify(needed)}. One line per simulated day:`);
  const ranAt = new Date().toISOString();
  let runId = "unknown";
  try {
    const live = await replayStream(stream, { mode: "on", mcp, datapacks, progress: (line) => console.log(`  ${line}`) });
    runId = live.runId;
    return live;
  } finally {
    logUsage({ ranAt, runId, mcp: Object.fromEntries(mcp.calls) }); // even for a failed run: Meko counted what was sent
    await mcp.close();
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
  if (r.audit) console.log(`hygiene audit passed: kept ${r.audit.kept} signals, deleted ${r.audit.deleted} other memories`);
  if (r.mekoCalls) console.log(`Meko calls ${JSON.stringify(r.mekoCalls)}; case conversations ${Object.keys(r.conversations?.cases ?? {}).length}`);
  if (r.metrics) console.log(formatMetrics(r.metrics));
}
