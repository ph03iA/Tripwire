import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "../agents/index.js";
import type { ReviewInput } from "../agents/review.js";
import { generate } from "../generator/generate.js";
import { replayStream, type RunRecord } from "./replay.js";
import { type Reviewer, silentReviewer } from "./review.js";

const stream = { seed: 42, ...generate(42) };
const rules = await replayStream(stream);
const decisions = (r: RunRecord) => r.decisions.map((d) => [d.eventId, d.action, d.risk, d.outcome]);
const stoppedAt = (r: RunRecord, chain: string) => r.metrics!.chains.find((c) => c.chainId === chain)?.stoppedAt;

test("llm mode with a model that adds nothing gives exactly the rules' decisions: the floor", async () => {
  const silent = await replayStream(stream, undefined, { reviewer: silentReviewer });
  assert.equal(silent.status, "ok");
  assert.deepEqual(decisions(silent), decisions(rules));
  assert.deepEqual(silent.metrics, rules.metrics);
  assert.equal(rules.agents, "rules");
  assert.equal(silent.agents, "llm");
});

test("every event an agent handles is reviewed by its model exactly once, and a batch closes early only for a reason", async () => {
  const seen = new Map<string, string[]>();
  const recording: Reviewer = async (input: ReviewInput) => {
    seen.set(input.agent.name, [...(seen.get(input.agent.name) ?? []), ...input.events.map((e) => e.id)]);
    return { proposed: [], calls: 0 };
  };
  const run = await replayStream(stream, undefined, { reviewer: recording });
  const refused = new Set(run.denied.map((d) => d.eventId));
  for (const agent of AGENTS) {
    const handled = stream.events.filter((e) => agent.handles(e) && !refused.has(e.id)).map((e) => e.id);
    assert.deepEqual(seen.get(agent.name), handled, agent.name);
  }
  const decided = new Set(run.decisions.map((d) => d.eventId));
  for (const r of run.reviews!.filter((x) => x.reason === "decision")) assert.ok(decided.has(r.closedBy), `${r.closedBy} closed a batch for its decision`);
  assert.ok(run.reviews!.every((r) => r.reason === "end" || r.reason === "alarm" || r.events <= 50));
  assert.ok(run.reviews!.some((r) => r.reason === "alarm" && r.agent === "login" && r.closedBy === "evt_000481"), "s1's successful login trips the alarm");
});

/** Flags what a model flagged in llm-check: s1's spray (one rare browser), the success highest. */
const sprayFlagger: Reviewer = async ({ agent, events }) => ({
  calls: 1, model: "scripted",
  proposed: agent.name !== "login" ? [] : events.filter((e) => e.kind === "login" && e.userAgent.includes("X11; Linux x86_64") && e.userAgent.includes("Chrome/118"))
    .map((e) => ({ eventId: e.id, type: "credential_stuffing" as const, score: e.kind === "login" && e.success ? 0.9 : 0.6, evidence: "part of a spray on 16 accounts" })),
});

test("an AI signal on s1's successful login stops s1 and s5 at the login, two phases earlier, and only steps up", async () => {
  const run = await replayStream(stream, undefined, { reviewer: sprayFlagger });
  assert.deepEqual([stoppedAt(rules, "s1"), stoppedAt(rules, "s5")], [4, 4]);
  assert.deepEqual([stoppedAt(run, "s1"), stoppedAt(run, "s5")], [2, 2]);
  const login = run.decisions.find((d) => d.eventId === "evt_000481")!;
  assert.deepEqual([login.trigger, login.action, login.outcome], ["signal", "STEP_UP", "failed"], "the model alone can't block");
  assert.deepEqual(login.rulesApplied, ["login.ai-review", "policy.ai-cap"]);
  assert.match(login.reasoning, /Only the agents' models put it at BLOCK level/);
  assert.equal(run.metrics!.legitSensitiveBlocks, 0);
  assert.ok(run.signals.filter((s) => s.ruleId === "login.ai-review").length >= 39);
  // Stopping s1 at the login means its payout (evt_000483) never happens, so a legit event whose rules-mode risk came
  // from that payout's signal (evt_000807) rightly drops. Every other decision keeps at least its rules-mode risk.
  const neverHappened = new Set([...run.denied.map((d) => d.eventId), ...run.decisions.filter((d) => d.outcome === "failed" || d.outcome === "blocked").map((d) => d.eventId)]);
  const changed = rules.decisions.filter((before) => {
    const after = run.decisions.find((d) => d.eventId === before.eventId);
    return after && after.risk < before.risk;
  });
  assert.deepEqual(changed.map((d) => d.eventId), ["evt_000807"]);
  assert.ok(changed.every((d) => d.signalsUsed.some((key) => neverHappened.has(key.split("/")[0]!))), "its only evidence was an event that no longer happens");
});

test("a model that only repeats the rules at lower scores adds nothing", async () => {
  const echo: Reviewer = async ({ readings }) => ({ calls: 1, proposed: readings.map((r) => ({ eventId: r.eventId,
    type: rules.findings.find((f) => f.eventId === r.eventId && f.ruleId === r.ruleId)!.type, score: Math.max(0, r.score - 0.1), evidence: "again" })) });
  const run = await replayStream(stream, undefined, { reviewer: echo });
  assert.deepEqual(decisions(run), decisions(rules));
  assert.equal(run.reviews!.reduce((n, r) => n + r.added, 0), 0);
});
