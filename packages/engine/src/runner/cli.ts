// CLI: npm run replay -- [--seed 42] [--meko off] [--out runs]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatMetrics } from "../metrics.js";
import { replay } from "./replay.js";

const { values } = parseArgs({
  options: { seed: { type: "string", default: "42" }, meko: { type: "string", default: "off" }, out: { type: "string" } },
});
if (values.meko !== "off") {
  console.error(`--meko ${values.meko} isn't available yet: ON mode arrives with the Meko client (plan M2). Use --meko off.`);
  process.exit(2);
}

const record = await replay(Number(values.seed)); // a bad seed throws a RangeError before anything runs
// npm runs this from packages/engine; resolve --out from where the user typed the command.
const outDir = values.out ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out) : fileURLToPath(new URL("../../../../runs/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${record.runId}.json`);
writeFileSync(file, JSON.stringify(record, null, 1) + "\n");

const byType = new Map<string, number>();
for (const s of record.signals) byType.set(`${s.agent}/${s.type}`, (byType.get(`${s.agent}/${s.type}`) ?? 0) + 1);
console.log(`${record.status}: ${record.events} events, ${record.findings.length} findings, ${record.signals.length} signals → ${file}`);
for (const [type, n] of [...byType].sort()) console.log(`  ${type.padEnd(36)} ${n}`);
const actions = record.decisions.map((d) => d.action);
console.log(`${record.decisions.length} decisions (${["BLOCK", "STEP_UP", "ALLOW"].map((a) => `${a} ${actions.filter((x) => x === a).length}`).join(", ")}), `
  + `refused after a stop: ${record.denied.length}`);
if (record.metrics) console.log(formatMetrics(record.metrics));
if (record.status === "failed") {
  console.error(`run failed: ${record.error}`);
  process.exit(1);
}
