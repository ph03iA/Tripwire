# Agent instructions

Read this first in every session (Codex, Claude Code or any other agent).

**Project:** Tripwire, an entry for ContextCon 2026, Theme 3 "Remember the Attacker". It detects account takeovers with four agents (login, device, transaction, support) that share risk signals through Meko. Submission is due Jan 17, 2027, and we aim to submit by Jan 15.

## Source of truth
Read these before doing anything:
- [docs/prd.md](docs/prd.md): what we build and why. Requirement IDs (A1, C4, R8, …) are referenced everywhere else.
- [docs/plan.md](docs/plan.md): milestones M0–M7, week-1 checks K1–K11, quota budget, cut list.
- [docs/engineering-spec.md](docs/engineering-spec.md): how it's built: modules, contracts, rules, testing, CI and the PR workflow.
- [docs/design.md](docs/design.md): layout, agents, event schema, scenarios.
- [docs/meko-api.md](docs/meko-api.md): how Meko is called from TypeScript, and Free-plan limits.

If something you find here conflicts with those docs, the docs win. Update them when a decision changes.

For background only, `handoff/claude-session.md` holds the original planning conversation with Claude Code. It exists only on this machine (git-ignored), and the docs above supersede it.

## Ground rules
- **No paid LLM.** Decisions are deterministic: rules, shared Meko memory and approved patterns. Running it must cost $0.
- **Get the plan approved before writing code** for a new component or milestone. A bare "ok" is not approval.
- **Don't use CarryOn.**
- **Only risk signals and approved patterns are saved as Meko memories** (PRD R8). Pattern drafts are artifacts until approved.
- **Meko OFF means no Meko calls at all.** Develop in OFF mode to save the free quota.
- **Secrets:** the Meko key lives in `.env` as `MEKO_API_KEY`. It is never committed, printed or sent to the browser.

## Commands
```bash
npm install
npm run generate     # seeded synthetic stream → data/
npm run replay -- --seed 42 --meko off   # detection agents over the stream → runs/
npm run replay -- --seed 42 --meko dry   # the ON pipeline against an in-process Meko: counts the calls, spends nothing
npm run replay -- --seed 42 --meko on    # the real Meko account: spends quota, so only when asked
npm run knowledge    # regenerate knowledge/risk-rules.md after changing a rule
npm run upload-knowledge   # knowledge/ → tripwire-patterns on the real Meko account (no search quota); after a doc changes
npm run spike -- k9  # one week-1 check against the real Meko account: spends quota, so only when asked
npm run llm-check    # the same test calls to each Groq and Gemini candidate model (needs GROQ_API_KEY, GEMINI_API_KEY): free-tier quota, so only when asked
npm test
npm run typecheck
npm run lint         # ESLint; fails on any function with cyclomatic complexity over 10
```

## Code
TypeScript (strict, ES modules) in `packages/engine`. React + Vite for the dashboard (not started). Keep changes small and use what's already in the repo before adding a dependency.




---
name: cyclomatic-complexity
description: Refactor code to reduce cyclomatic complexity so it stays readable, maintainable, and aligned with the long-term vision of the codebase, not just optimized for AI comprehension. Use whenever the user asks to refactor, simplify, clean up, or review code quality; mentions complexity, maintainability, readability, spaghetti code, deeply nested logic, or god functions; or asks to check AI-generated code before merging. Also use proactively after writing any nontrivial function with heavy branching.
---

# Cyclomatic Complexity

Purpose: AI-written code often works but branches like a jungle. This skill: measure complexity, refactor hotspots, keep code human-maintainable.

## Measure first

CC = decision points + 1. Decision points: `if`, `else if`, `case`, loops, `catch`, ternary, `&&`, `||` in conditions.

Project linter config wins. If eslintrc, radon config, sonar config, or similar sets a complexity threshold, use that. No config: use defaults below.

Thresholds:
- 1-5: fine, leave alone
- 6-10: watch, refactor if touching anyway
- 11-15: refactor now
- 15+: must split, no debate

Prefer real tools over eyeballing when environment allows:
- Python: `radon cc -s -a <path>`
- JS/TS: eslint `complexity` rule
- Go: `gocyclo`
- Polyglot: `lizard <path>`

No tool available: count manually, per function, show the count.

## Refactor tactics, in order of preference

1. **Guard clauses.** Invert conditions, return early, kill nesting.
2. **Extract function.** Each extracted piece gets a name that says what, not how. Names are documentation.
3. **Lookup table / map** instead of if-else or switch chains.
4. **Named predicates.** `if (isEligibleForRefund(order))` beats a 4-clause boolean soup.
5. **Polymorphism / strategy** for switch-on-type. Only when the switch appears in 2+ places.
6. **Flatten loops.** Extract loop body, use continue instead of nested if.

## Hard rules

- Preserve behavior. Run tests before and after. No tests: say so, suggest adding, refactor conservatively.
- Don't game the metric. A dense one-liner hiding 6 branches is worse than the honest if-chain it replaced. Complexity should move into well-named units, not disappear into cleverness.
- Don't break public APIs or exported signatures without asking.
- Small functions with clear names > few functions with comments explaining sections.
- One responsibility per function. If the name needs "and", split.

## Workflow

1. Measure all touched functions, rank by CC descending.
2. Report hotspots with numbers before touching anything.
3. Refactor worst first, one function at a time.
4. Re-measure. Show before/after table: function, CC before, CC after.
5. Verify: tests pass, behavior unchanged, diff reviewable.

## Output format

End every refactor with:

```
## Complexity report
| Function | Before | After |
|----------|--------|-------|
| parseOrder | 14 | 4 |

Extracted: validateHeader, resolveDiscount
Behavior verified: <how>
```

Keep prose minimal. Numbers and diffs do the talking.


