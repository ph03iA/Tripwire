import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/**", "data/**", "runs/**", "handoff/**", "**/dist/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // AGENTS.md: 11+ must be refactored, so anything over 10 fails the build.
      complexity: ["error", 10],
    },
  },
  {
    // PRD R3: agents never see ground truth: no generator, runner, metrics, labels file or data folder.
    // Checked by packages/engine/src/lint.test.ts.
    files: ["packages/engine/src/agents/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/generator/**", "**/runner/**", "**/metrics*", "**/labels.json", "**/data/**"],
          message: "Agents must not see labels (PRD R3).",
        }],
      }],
    },
  },
);
