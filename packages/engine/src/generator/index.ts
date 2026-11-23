// CLI: npm run generate -- [--seed 42] [--out data]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generate } from "./generate.js";

const { values } = parseArgs({ options: { seed: { type: "string", default: "42" }, out: { type: "string" } } });
const { events, labels, accounts } = generate(Number(values.seed)); // throws a RangeError on a bad seed

// npm runs this from packages/engine; resolve --out from where the user typed the command.
const outDir = values.out
  ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out)
  : fileURLToPath(new URL("../../../../data/", import.meta.url));

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(outDir, "labels.json"), JSON.stringify(labels, null, 1) + "\n");
writeFileSync(join(outDir, "accounts.json"), JSON.stringify(accounts, null, 1) + "\n");

const counts = new Map<string, number>();
for (const l of labels) counts.set(l.scenario, (counts.get(l.scenario) ?? 0) + 1);
console.log(`seed ${values.seed}: ${events.length} events, ${accounts.length} accounts → ${outDir}`);
for (const [scenario, n] of counts) console.log(`  ${scenario.padEnd(20)} ${n}`);
