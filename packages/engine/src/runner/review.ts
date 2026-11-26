import type { Closer } from "../agents/batch.js";
import { checkReview, type Prompt, type Proposed, type ReviewInput, reviewPrompt } from "../agents/review.js";
import { ConfigError } from "../config.js";
import { overBudget, usedToday } from "../llm/budget.js";
import type { LlmClient, TokenUsage } from "../llm/client.js";
import type { ModelSpec } from "../llm/models.js";
import type { AgentName } from "../types.js";

/** What reviewing one batch produced: the model's proposals, who answered, and why the floor stood alone, if it did. */
export type ReviewResult = { proposed: Proposed[]; model?: string; calls: number; tokens?: TokenUsage; fallback?: string };
export type Reviewer = (input: ReviewInput) => Promise<ReviewResult>;
/** One batch review in the run record. */
export type Review = {
  agent: AgentName; reason: Closer; closedBy: string; events: number; promptChars: number;
  model?: string; calls: number; tokens?: TokenUsage; proposed: number; added: number; fallback?: string;
};

/** Proposes nothing and calls no model: the dry pass that counts a run's batch reviews, where only the rules' signals stand. */
export const silentReviewer: Reviewer = async () => ({ proposed: [], calls: 0 });

const NONE: TokenUsage = { input: 0, cached: 0, output: 0, total: 0 };
const fitsToday = (model: ModelSpec, tokens: number) => overBudget(model, usedToday(model), { requests: 1, tokens }) === null;

/**
 * Asks the agent's models in order. A model that's out of today's quota, or that fails (a refusal, a 429 the client
 * couldn't wait out, a timeout), is out for the rest of the run and hands over to the next. An answer that fails
 * validation is asked once more; a second bad answer leaves the batch with the rules' signals only (the floor).
 */
export function llmReviewer({ client, models, canUse = fitsToday }: { client: LlmClient; models: ModelSpec[]; canUse?: (model: ModelSpec, tokens: number) => boolean }): Reviewer {
  const out = new Map<string, string>(); // model name → why it's out for the rest of the run
  return async (input) => {
    const prompt = reviewPrompt(input);
    const tokens = Math.ceil((prompt.system.length + prompt.user.length) / 3);
    for (const model of models.filter((m) => !out.has(m.name))) {
      if (!canUse(model, tokens)) {
        out.set(model.name, "out of today's quota");
        continue;
      }
      try {
        return await askTwice(client, model, prompt, input);
      } catch (err) {
        if (err instanceof ConfigError) throw err; // a missing key fails the run, rather than quietly running without AI
        out.set(model.name, err instanceof Error ? err.message : String(err));
      }
    }
    return { proposed: [], calls: 0, fallback: `no model left (${[...out].map(([m, why]) => `${m}: ${why}`).join("; ")})` };
  };
}

async function askTwice(client: LlmClient, model: ModelSpec, prompt: Prompt, input: ReviewInput): Promise<ReviewResult> {
  let tokens = NONE;
  let problem = "";
  for (let calls = 1; calls <= 2; calls++) {
    const answer = await client.chat({ model, ...prompt });
    tokens = { input: tokens.input + answer.usage.input, cached: tokens.cached + answer.usage.cached, output: tokens.output + answer.usage.output,
      total: tokens.total + answer.usage.total };
    const checked = answer.json === undefined ? { proposed: [], problems: [`the answer isn't JSON (finish reason: ${answer.finishReason})`] }
      : checkReview(answer.json, input.agent, input.events);
    if (checked.problems.length === 0) return { proposed: checked.proposed, model: model.name, calls, tokens };
    problem = checked.problems[0]!;
  }
  return { proposed: [], model: model.name, calls: 2, tokens, fallback: `invalid answer twice: ${problem}` };
}
