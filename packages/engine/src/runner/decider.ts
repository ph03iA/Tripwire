import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkJudgment, type Judgment, type JudgmentInput, judgmentPrompt, keyOf, type Knowledge } from "../agents/judgment.js";
import { ConfigError } from "../config.js";
import { KNOWLEDGE_DIR, playbookFiles, POLICY_FILE } from "../knowledge/upload.js";
import { overBudget, usedToday } from "../llm/budget.js";
import type { LlmClient, TokenUsage } from "../llm/client.js";
import type { ModelSpec } from "../llm/models.js";
import type { RiskSignal } from "../types.js";

/** What asking the decision agent's models produced. Without a judgment, the rules decide, and `fallback` says why. */
export type DecideResult = {
  judgment?: Judgment; signals: RiskSignal[]; model?: string; calls: number; tokens?: TokenUsage; fallback?: string;
  needMore?: { entity: string; found: number };
};
/** `lookup` runs the one extra search a judgment may ask for, and returns what it found. */
export type Decider = (input: JudgmentInput, lookup: (entity: string) => Promise<RiskSignal[]>) => Promise<DecideResult>;

/** The step-up policy and the playbooks from knowledge/, the same documents uploaded to the knowledge base. */
export const localKnowledge = (): Knowledge => ({
  policy: readFileSync(join(KNOWLEDGE_DIR, POLICY_FILE), "utf8"),
  playbooks: playbookFiles().map((f) => readFileSync(f, "utf8")),
});

const NONE: TokenUsage = { input: 0, cached: 0, output: 0, total: 0 };
const fitsToday = (model: ModelSpec, tokens: number) => overBudget(model, usedToday(model), { requests: 1, tokens }) === null;
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, total: a.total + b.total });

/**
 * Asks the decision models in order, as the detection reviewer does: a model out of quota or failing hands over to
 * the next, a bad answer is asked once more, and two bad answers leave the decision to the rules. A judgment that asks
 * for more evidence gets one search and one more question, with what the search found among its signals.
 */
export function llmDecider({ client, models, knowledge, canUse = fitsToday }: {
  client: LlmClient; models: ModelSpec[]; knowledge: Knowledge; canUse?: (model: ModelSpec, tokens: number) => boolean;
}): Decider {
  const out = new Map<string, string>();
  return async (input, lookup) => {
    const prompt = judgmentPrompt(input, knowledge);
    for (const model of models.filter((m) => !out.has(m.name))) {
      if (!canUse(model, Math.ceil((prompt.system.length + prompt.user.length) / 3))) {
        out.set(model.name, "out of today's quota");
        continue;
      }
      try {
        return await decideWith(client, model, input, knowledge, lookup);
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        out.set(model.name, err instanceof Error ? err.message : String(err));
      }
    }
    return { signals: input.signals, calls: 0, fallback: `no model left (${[...out].map(([m, why]) => `${m}: ${why}`).join("; ")})` };
  };
}

async function decideWith(client: LlmClient, model: ModelSpec, input: JudgmentInput, knowledge: Knowledge,
  lookup: (entity: string) => Promise<RiskSignal[]>): Promise<DecideResult> {
  const first = await askTwice(client, model, input, knowledge);
  if (!first.judgment?.needMore) return { ...first, signals: input.signals, model: model.name };
  const entity = first.judgment.needMore;
  const found = await lookup(entity);
  const known = new Set(input.signals.map(keyOf));
  const signals = [...input.signals, ...found.filter((s) => !known.has(keyOf(s)))];
  const second = await askTwice(client, model, { ...input, signals, asked: { entity } }, knowledge);
  const tokens = add(first.tokens, second.tokens);
  const needMore = { entity, found: signals.length - input.signals.length };
  // A second question that fails twice keeps the first judgment, made on the signals it had.
  if (!second.judgment) return { judgment: first.judgment, signals: input.signals, model: model.name, calls: first.calls + second.calls, tokens, needMore };
  return { judgment: second.judgment, signals, model: model.name, calls: first.calls + second.calls, tokens, needMore };
}

async function askTwice(client: LlmClient, model: ModelSpec, input: JudgmentInput, knowledge: Knowledge) {
  const prompt = judgmentPrompt(input, knowledge);
  let tokens = NONE;
  let problem = "";
  for (let calls = 1; calls <= 2; calls++) {
    const answer = await client.chat({ model, ...prompt });
    tokens = add(tokens, answer.usage);
    const checked = answer.json === undefined ? { problems: [`the answer isn't JSON (finish reason: ${answer.finishReason})`] }
      : checkJudgment(answer.json, input.signals);
    if (checked.judgment) return { judgment: checked.judgment, calls, tokens };
    problem = checked.problems[0]!;
  }
  return { judgment: undefined, calls: 2, tokens, fallback: `invalid answer twice: ${problem}` };
}
