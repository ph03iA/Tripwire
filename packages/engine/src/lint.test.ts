import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT_FILE = `${ROOT}packages/engine/src/agents/probe.ts`; // never written: ESLint lints the text as if it were there

async function restrictedImports(source: string): Promise<number> {
  const [result] = await new ESLint({ cwd: ROOT }).lintText(`import x from "${source}";\nexport default x;\n`, { filePath: AGENT_FILE });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports").length;
}

test("agents can't import ground truth: the generator, runner, metrics, labels file or data folder (PRD R3)", async () => {
  for (const source of ["../generator/generate.js", "../runner/replay.js", "../metrics.js", "../../../../data/labels.json", "../../../../data/events.jsonl"]) {
    assert.equal(await restrictedImports(source), 1, source);
  }
  assert.equal(await restrictedImports("../store/store.js"), 0, "the store is allowed");
});
