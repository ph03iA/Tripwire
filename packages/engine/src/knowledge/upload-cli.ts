// CLI: npm run upload-knowledge — uploads the knowledge docs into tripwire-patterns (PRD A5, C2).
// Calls the real Meko account. It spends no search quota: uploads are REST calls and a few KB of storage.
import { basename } from "node:path";
import { mekoConfig } from "../config.js";
import { findDatapack, restClient } from "../meko/rest.js";
import { knowledgeFiles, PATTERNS_DATAPACK, uploadFile } from "./upload.js";

const rest = restClient(mekoConfig());
const datapackId = await findDatapack(rest, PATTERNS_DATAPACK);
for (const file of knowledgeFiles()) {
  const { outcome, olderDeleted } = await uploadFile(rest, datapackId, file);
  console.log(`${outcome.padEnd(9)} ${basename(file)}${olderDeleted ? `, ${olderDeleted} older copy or copies deleted` : ""}`);
}
console.log(`REST calls: ${JSON.stringify(Object.fromEntries(rest.calls))}`);
