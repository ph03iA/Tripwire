# Tripwire: Engineering Spec

| | |
| --- | --- |
| Status | v1, 2026-11-23 |
| Scope | How Tripwire is built: module boundaries, contracts, algorithms, storage, Meko integration, errors, testing, CI and the PR workflow |
| Related | [PRD](prd.md) (what and why) · [Build plan](plan.md) (when) · [Technical design](design.md) (data model and scenarios) · [Meko API notes](meko-api.md) |

When documents disagree, the PRD wins on behavior and this spec wins on implementation. Update both in the same PR when a decision changes.

## 1. Engineering rules

These apply to every PR. CI enforces the first two.

1. **Complexity ≤ 10 per function**, enforced by ESLint's `complexity` rule (AGENTS.md). 6–10 is "watch": split it if you touch it anyway. To lower it, prefer guard clauses, named predicates and lookup tables over clever one-liners.
2. **Lint, typecheck and tests pass** on Node 22 and 24.
3. **The smallest complete change** (ponytail):
   - Reuse what the repo has, then the standard library, then an installed dependency.
   - No speculative options, wrappers or "for later" code.
   - A known limit gets a `shortcut: <the limit>, <when to upgrade>` comment.
4. **Every non-trivial piece of logic has a test** (a branch, a loop, a parser, a rule, a query). Tests use a real PGlite database, not mocks, wherever the code touches the store.
5. **Never cut:**
   - validation at trust boundaries (env, CLI args, Meko responses, HTTP input)
   - error handling that prevents data loss or wrong metrics
   - security
   - accessibility
6. **Agents never see ground truth.** Code under `src/agents/` may not import the generator, the runner or the metrics (ESLint `no-restricted-imports`). Only the runner (for OTP outcomes) and `metrics.ts` read labels.
7. **Deterministic by default:** same seed and mode, same decisions. No `Date.now()` or `Math.random()` in decision paths. Time comes from the event being replayed.

## 2. Module map

```
packages/engine/src/
  types.ts                 events, labels, profiles, signals (shared by everything)
  generator/               seeded stream (done): world, scenarios, decoys, background, generate, CLI
  store/store.ts           event store on PGlite: schema, insert, named history queries
  agents/
    types.ts               Agent, Rule, Finding, AgentContext
    login.ts device.ts txn.ts support.ts   one detection agent each: a list of rules
    geo.ts                 city coordinates for impossible travel
    index.ts               AGENTS, ownerOf(), detect(), noisyOr()
  knowledge/render.ts      renders knowledge/risk-rules.md from the agents' rules
  signals/local.ts         OFF mode: each agent's own signals, in process
  runner/replay.ts         the world simulator: replay loop, run record
  runner/cli.ts            npm run replay
  ── later milestones ──
  config.ts                env parsing and validation (M0, with the Meko client)
  log.ts                   JSON-lines logger to stderr (M0)
  meko/mcp.ts rest.ts      Meko client (M0)
  signals/meko.ts          ON mode signal store (M2)
  agents/decision.ts       decision agent (M2)
  runner/outcomes.ts       stops, step-ups, prevention (M2)
  runner/quota.ts          monthly quota ledger and guard (M2)
  metrics.ts               scoring against labels (M2)
  agents/analyst.ts        pattern drafts, incident reports (M3)
  server/                  Hono + SSE for the dashboard (M4)
packages/dashboard/        React + Vite (M4–M5)
knowledge/                 risk-rules.md (generated), fraud playbooks, step-up policy
```

Dependencies only point downward: `types` ← `store` ← `agents` ← `signals` ← `runner` ← `server`/CLIs.

## 3. Event store (D4)

PGlite (Postgres compiled to WebAssembly) runs in process, so the store needs no install, no account and no network. Each run gets a fresh in-memory database.
`shortcut: PGlite in memory, one run per database; switch openStore() to a pg Pool on Meko AMP once K5 confirms the Free plan has it.` The SQL is standard Postgres, so only `openStore()` changes.

**No future data, by construction:** for each event, the runner first runs the agents against the store, *then* inserts the event. A query can therefore only ever see strictly earlier events. A test replays a stream and checks that no query result references an event at or after the one being processed.

```sql
create table events (
  seq integer primary key,          -- replay order
  id text unique not null,
  ts timestamptz not null,
  account_id text not null,
  kind text not null,
  success boolean, channel text,    -- login / password_reset / account_change / support_contact
  device_id text, ip text, user_agent text, city text, country text,
  type text, amount_minor integer, payee_id text, payee_is_new boolean, merchant_id text,
  body jsonb not null               -- the full event, for anything not in a column
);
create index on events (account_id, ts);
create index on events (device_id, ts);
```

Amounts fit in `integer`: the largest planted payment is ₹2,00,000, which is 2 × 10⁷ paise. Counts are cast to `int` in SQL, so they come back as JS numbers.

The history queries are named functions, so agents never write SQL:

| Query | Used by |
| --- | --- |
| `failedLogins(account, since)` | login: failure burst, failures then success |
| `lastActivity(account)`: the last successful client event's time and city | login: impossible travel |
| `resetSince(account, since, channel?)` | login: after support reset; device: new after reset |
| `deviceSeenOnAccount(account, device)` | device: new device |
| `otherAccountsOnDevice(device, account, since)` | device: shared device |
| `smallCharges(account, since)`: count and distinct merchants under ₹50 | txn: card testing |
| `medianAmount(account)`: median and count of earlier transactions | txn: amount anomaly |

## 4. Detection agents (A1–A6)

```ts
type Finding = { ruleId: string; type: SignalType; score: number; evidence: string };
type Rule = {
  id: string;                // "login.failure-burst", shown in traces and risk-rules.md
  type: SignalType;
  when: string;              // one human sentence with the thresholds, rendered into risk-rules.md
  fire(e: TripwireEvent, ctx: AgentContext): Promise<Finding | null>;
};
type Agent = { name: AgentName; handles(e: TripwireEvent): boolean; rules: Rule[]; contextRules: ContextRule[] };
type AgentContext = { history: History; profile(accountId: string): AccountProfile | undefined; uaShare(ua: string): number };
```

**Pipeline, per agent, per event:**
1. Run the base rules (history and profile only).
2. If the noisy-OR of the findings is ≥ 0.2, recall signals for the account and the event's device, IP and payee. In OFF mode that is only this agent's own signals; in ON mode it is everyone's, through Meko. Then run the context rules against them.
3. Keep every finding in the run record. Write a signal for each finding with score ≥ 0.4.

`noisyOr(scores) = 1 − Π(1 − sᵢ)`.

**Routing:** each event goes to its owning agent and, if it has client fields, to the device agent. The owners are: `login` and `password_reset` → login; `transaction` → txn; `support_contact` and `account_change` → support. `step_up_result` goes to no agent.

### Initial rules

Starting values, tuned on seed 42 only. The code is the source of truth: `knowledge/risk-rules.md` is generated from the rules' own `when` sentences (`npm run knowledge`), and a test fails if the committed file differs, so code and knowledge base can't drift (A5).

| Agent | Rule | Signal | Fires when | Score |
| --- | --- | --- | --- | --- |
| login | `login.failure-burst` | credential_stuffing | a failed login brings the account to ≥ 5 failures in 15 min | 0.6, or 0.8 at ≥ 10 |
| login | `login.failures-then-success` | failures_then_success | a successful login after ≥ 2 failures in the previous 30 min | 0.3 |
| login | `login.impossible-travel` | impossible_travel | a successful login whose distance from the account's last successful activity needs > 900 km/h | 0.7 |
| login | `login.after-support-reset` | login_after_support_reset | a successful login within 60 min of a password reset via support | 0.7 |
| device | `device.new-device` | new_device | a device that isn't in the profile and was never used on the account. Failed logins don't count, in either direction: they don't show the device got in. | 0.4, so it's shared: the support agent's context rule needs it |
| device | `device.shared` | shared_device | a device used by other accounts in the last 7 days | 0.5 for one other, 0.7 for two, 0.8 for three or more |
| device | `device.rare-ua` | rare_user_agent | a browser string on < 2% of the devices in all profiles | 0.2 |
| device | `device.new-after-reset` | new_device_after_reset | a password reset made from a new device, or a new device within 60 min of any reset | 0.6 |
| txn | `txn.card-testing` | card_testing | a charge under ₹50 that makes ≥ 3 such charges at ≥ 3 merchants in 30 min | 0.6 |
| txn | `txn.cash-out-after-testing` | card_testing | a charge of at least ₹10,000 within 60 min of ≥ 3 charges under ₹50 at ≥ 3 merchants | 0.8 |
| txn | `txn.high-value-new-payee` | high_value_new_payee | a transfer of at least ₹50,000 to a new payee | 0.5, or 0.6 at ≥ ₹1,00,000 |
| txn | `txn.payout-new-bank` | payout_new_bank | a payout to a new bank account | 0.4, or 0.6 at ≥ ₹50,000 |
| txn | `txn.amount-anomaly` | amount_anomaly | at least ₹10,000 and ≥ 5× the median of ≥ 3 earlier transactions | 0.4 |
| support | `support.weak-verification` | weak_verification | a reset or email-change request verified by KBA, or not verified; a failed check is its own case | 0.5 (KBA), 0.6 (none), 0.4 (failed) |
| support | `support.caller-mismatch` | caller_mismatch | the caller's phone isn't on file, or the registered phone calls from outside the home city | 0.3 unknown phone, 0.4 unknown and away, 0.2 registered but away |
| support | `support.sensitive-change` | sensitive_change | an email, phone, payout-method or 2FA change | 0.4 |
| support | `support.change-after-new-device` (context) | sensitive_change | a sensitive change within 60 min after a recalled `new_device` signal from a successful login on the account (signals carry their `eventKind`) | 0.6 |

Impossible travel compares successful activity only: failed attempts come from rotating proxies and don't place the user anywhere. Cities missing from `agents/geo.ts` produce no finding (`shortcut:` comment in code).

## 5. Runner (R1, R4, R6)

```ts
replay(seed): Promise<RunRecord>                                  // OFF mode; ON arrives in M2
replayStream({ seed, events, accounts }): Promise<RunRecord>      // the same loop on any input, used by tests
```

1. `generate(seed)` builds the events, labels and profiles in process. The runner never parses the committed files, so there is no file trust boundary to validate.
2. Open the store. Build the profile lookup and the browser-string shares. Create one `LocalSignalStore` per agent (OFF mode).
3. For each event in order: route it, run each agent's pipeline, write its signals, then insert the event.
4. Return and save the run record:
   ```ts
   type RunRecord = {
     runId: string; seed: number; meko: "off" | "on"; status: "ok" | "failed"; error?: string;
     startedAt: string; finishedAt: string; events: number;
     findings: (Finding & { agent: AgentName; eventId: string })[];  // every finding, written or not
     signals: RiskSignal[];                                           // the written ones (score ≥ 0.4)
   };
   ```
   `runId` = `<seed>-<mode>-<ISO time>`. Records go to `runs/<runId>.json` (git-ignored; demo runs get committed in M6).

**Failure policy:**
- **Input is validated before anything is scored.** Timestamps must parse and never go backwards; equal times keep their input order. Every account needs a profile.
- **Results are published only after the event is stored.** An event's findings and signals are staged, the event is stored, and only then do they reach the record and the signal store. A failed insert therefore leaves nothing from that event behind.
- **Any error stops the run.** That includes opening or closing the store. A record with `status: "failed"` and the first error is still written.
- **No silent fallback.** A run never falls back from ON to OFF, because that would corrupt the comparison.

`--meko on` fails with a clear message until the Meko client lands (M0/M2).

## 6. Later milestones: contracts to honor

These are fixed now so that earlier code doesn't box them in; each lands in its own PR.

- **Config (M0):** `config.ts` reads `process.env` once, after `process.loadEnvFile()` when `.env` exists (Node built-in, no dotenv). Variables:
  - `MEKO_API_KEY`: required for ON mode
  - `MEKO_MCP_URL`, default `https://mcp.mekodata.ai/mcp`
  - `MEKO_API_URL`, default `https://api.mekodata.ai/api/v1`
  - `MEKO_SIGNALS_DATAPACK`, `MEKO_PATTERNS_DATAPACK`: datapack IDs
  - `TRIPWIRE_LOG_LEVEL`, default `info`

  A missing or malformed value fails at startup with a message naming the variable. The key is never logged.
- **Meko client (M0):**
  - MCP through `@modelcontextprotocol/sdk` (`StreamableHTTPClientTransport`). REST through `fetch`.
  - Both send `Authorization: Bearer` and `User-Agent: tripwire/<version>`, with a 10 s timeout.
  - **Retries depend on the operation**, because a write whose response is lost may still have been saved, and `memory_add` stores duplicates:

    | Operation | On 429 | On 5xx, timeout or network error |
    | --- | --- | --- |
    | Reads: searches, gets, lists, document status | Retry | Retry |
    | Idempotent writes: `artifact_put` (keyed by content hash), datapack create (a repeat returns 409) | Retry | Retry |
    | `memory_add` | Retry (the request was refused, not processed) | **Never resend.** Look for the signal's stable key (event ID + rule ID, written into its text) in the newest page of `memory_get_all` and with `memory_search`, a few times over the indexing delay K1 measures. A hit confirms the write. A miss proves nothing, because the first write may be saved but not yet indexed, so the write stays unresolved: record the run as failed and stop. |
    | `POST /promote-memories` | Retry | Check the promoted list for the ID first; promote again only if it's absent |
    | `conversation_add_message`, `conversation_create` | Retry | No way to check, so mark the run `incomplete` with the event ID. Never resend blindly. |

    Retries use 3 attempts with exponential backoff and jitter (0.5 s → 4 s) and honor `Retry-After`. Other 4xx responses fail at once.
  - Every response is checked by a type guard before use. An unexpected shape is an error, not a guess.
  - Every call is counted for the quota ledger (R7).
- **ON signal store (M2):** `memory_add` with `agent_id` and metadata. Recall uses `memory_search`. A result counts only if its ID was written by this run (provenance, R8), it names the same entity, and it falls inside the 72-hour window. Every search becomes a `Retrieval` record (C3).
- **Decision agent (M2):**
  - Triggers per C1. Risk is the noisy-OR of the strongest signal per type in 72 h.
  - Policy: ≥ 0.8 BLOCK, 0.5–0.8 STEP-UP, else ALLOW. A known device plus travel alone is capped at STEP-UP.
  - The reason is a template over the decision record, so nothing is generated text.
  - **Traces:**
    - Each STEP-UP and BLOCK gets its own trace turn (C4).
    - Every ALLOW, with or without signals, goes into the daily allow ledger with its reason, signals and searches (C5).
    - Seed 42 has 275 decision triggers, 90 of them with a shared signal on the event itself. One turn per signal-backed ALLOW wouldn't fit the 120-call ceiling, while STEP-UPs and BLOCKs should number in the tens.
- **Dry run (M2, before the first ON run):** `--meko dry` runs the whole ON pipeline against an in-process stand-in for Meko and reports the conversation calls and searches the run would make. The quota guard and the PRD §9 ceiling are checked against these measured numbers, not estimates.
- **Outcomes (M2):** R2 and R3. The runner decides OTP outcomes from the labels, and records attempted versus executed takeover events. Prevention is computed from execution (PRD §8).
- **Quota guard (M2):** `runs/quota.json` keeps a per-month ledger of conversation calls and searches. An ON run refuses to start when its ceiling (PRD §9) doesn't fit the remainder.
- **Learning loop (M3):** L1–L4 exactly as the PRD states, including the approval conversation and confirmation in the promoted list.

## 7. Testing

| Level | What | Where |
| --- | --- | --- |
| Unit | Each rule, positive and negative, against a PGlite store seeded with a few events | `agents/*.test.ts` |
| Unit | Store queries, including the no-future-data property | `store/store.test.ts` |
| Unit | `noisyOr`, routing, risk-rules rendering matches the committed file | `agents/index.test.ts`, `knowledge/render.test.ts` |
| Integration | OFF replay of seed 42: completes, writes the planted scenarios' expected signals, writes no signal from ground truth | `runner/replay.test.ts` |
| Generator | Determinism, size, chains, no attack-only values, traveler fixture, CLI | `generator/generate.test.ts` (done) |
| Live (later) | ON mode against real Meko, opt-in with `TRIPWIRE_LIVE=1`. Never in CI: it needs secrets and spends quota. | `*.live.test.ts` |

Tests run with `node:test` through `tsx --test`; there is no test framework dependency.

## 8. CI and quality gates

GitHub Actions on every push to `main` and every PR, Node 22 and 24:
1. `npm ci`
2. `npm run lint`: ESLint, with complexity ≤ 10 and the agent import boundary
3. `npm run typecheck`
4. `npm test`
5. The committed `data/` matches `npm run generate` (`git diff --exit-code`). `knowledge/risk-rules.md` is checked by a unit test.

TypeScript stays on 6.0.x until typescript-eslint supports 7 (it needs the TypeScript JavaScript API, which 7.0 dropped). Node 20 reached end of life in April 2026, so the floor is Node 22 (`engines`).

**Done means:** CI is green, new logic has tests, the PRD requirement IDs are named in the PR, docs are updated when behavior changes, and the diff has no secrets or real customer data.

## 9. Git workflow

- **Branches:** `feat/…`, `fix/…`, `docs/…`, `chore/…`, one feature each. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- **PRs:** one per branch, filled from `.github/pull_request_template.md`. A PR that depends on another is stacked on it: its base is the earlier branch, so its diff shows only its own work.
- **Merging stacked PRs:** merge bottom-up with **"Create a merge commit"**. GitHub then retargets the next PR to `main` and its diff stays clean. Squash or rebase would make later PRs show earlier work again.
- **`main`** is always green. It's worth protecting in the repo settings: require the CI check and a PR.

## 10. Delivery sequence

| # | Branch | Scope | Requirements | Base |
| --- | --- | --- | --- | --- |
| 1 | `docs/engineering-spec` | This document | | `main` |
| 2 | `chore/ci` | ESLint (complexity, agent boundary), CI workflow, PR template, TypeScript 6.0, Node ≥ 22 | §1, §8 | `docs/engineering-spec` |
| 3 | `feat/event-store` | PGlite store, schema, history queries, no-future-data test | D4 | `chore/ci` |
| 4 | `feat/detection-agents` | The four agents and their rules, `risk-rules.md` rendering, fraud playbooks, step-up policy text | A1–A6, C2 (text) | `feat/event-store` |
| 5 | `feat/runner-off` | Local signal store, replay loop, run record, `npm run replay`, OFF integration test | R1, R4, R6 | `feat/detection-agents` |
| 6 | `feat/meko-client` | Config, logger, MCP and REST clients, spike script for K1–K11 | M0, K1–K11 | needs `MEKO_API_KEY` |
| 7+ | M2 onward | ON signals, decision agent, outcomes, traces and ledger, hygiene audit, metrics, quota guard; then M3–M6 per the plan | | |
