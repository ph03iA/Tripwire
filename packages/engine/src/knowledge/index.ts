// CLI: npm run knowledge — regenerates knowledge/risk-rules.md from the agents' rules.
import { writeFileSync } from "node:fs";
import { RISK_RULES_PATH, renderRiskRules } from "./render.js";

writeFileSync(RISK_RULES_PATH, renderRiskRules());
console.log(`wrote ${RISK_RULES_PATH}`);
