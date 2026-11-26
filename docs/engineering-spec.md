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
  knowledge/upload.ts      uploads knowledge/ into tripwire-patterns; npm run upload-knowledge
  agents/decision.ts       decision agent: triggers, risk, policy, reasoning (pure)
  signals/local.ts         OFF mode: each agent's own signals, in process
  signals/meko.ts          ON mode: everyone's signals through Meko, one search per event
  config.ts                env parsing and validation
  meko/mcp.ts rest.ts      Meko client; retry.ts holds the retry policy, spike.ts the week-1 checks
  meko/dry.ts              in-process stand-in for Meko: --meko dry, and the tests' Meko
  runner/replay.ts         the world simulator: replay loop, run record
  runner/outcomes.ts       stops, step-ups, locks
  runner/trace.ts          run, case and ledger conversations, quotes, trace turns, the R8 audit
  runner/quota.ts          monthly quota guard
  runner/cli.ts            npm run replay
  metrics.ts               scoring against labels
  ── later milestones ──
  agents/analyst.ts        pattern drafts, incident reports (M3)
  server/                  Hono + SSE for the dashboard (M4)
packages/dashboard/        React + Vite (M4–M5)
knowledge/                 risk-rules.md (generated), fraud playbooks, step-up policy
```

Dependencies only point downward: `types` ← `store` ← `agents` ← `signals` ← `runner` ← `server`/CLIs.

## 3. Event store (D4)

PGlite (Postgres compiled to WebAssembly) runs in process, so the store needs no install, no account and no network. Each run gets a fresh in-memory database.
`shortcut: PGlite in memory, one run per database; switch openStore() to a pg Pool on Meko AMP once K5 confirms the Free plan has it.` The SQL is standard Postgres, so only `openStore()` changes. K5 found AMP on the Free plan, capped at 0.5 vCPU. The recommendation is still to stay on PGlite: OFF mode must make no Meko calls, and every history query would cross the network ([spikes](spikes.md)).

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
2. If the noisy-OR of the findings is ≥ 0.2 and the agent has a context rule, recall signals for the account and the event's device, IP and payee. In OFF mode that is only this agent's own signals; in ON mode it is everyone's, through Meko. Then run the context rules against them. Recalled signals feed nothing else, so an agent without a context rule never recalls: in ON mode each recall is a Meko search. Today only the support agent has one.
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
replayStream({ seed, events, labels, accounts }): Promise<RunRecord>  // the same loop on any input, used by tests
```

1. `generate(seed)` builds the events, labels and profiles in process. The runner never parses the committed files, so there is no file trust boundary to validate.
2. Open the store. Build the profile lookup and the browser-string shares. Create one `LocalSignalStore` per agent (OFF mode).
3. For each event in order:
   1. If an earlier stop refuses it (R2, below), record the denial and move on: no agent sees it and it isn't stored.
   2. Route it, run each agent's pipeline, insert the event, then write its signals.
   3. If it triggers a decision (C1), run the decision agent and apply the outcome: a BLOCK stops; a STEP-UP gets a `step_up_result` event (`<event id>-otp`, same time), which is stored, and a failed one stops.
4. Score the run against the labels (`metrics.ts`, PRD §8), from what the runner refused.
5. Return and save the run record:
   ```ts
   type RunRecord = {
     runId: string; seed: number; meko: "off" | "on"; status: "ok" | "failed"; error?: string;
     startedAt: string; finishedAt: string; events: number;          // stored or refused
     findings: (Finding & { agent: AgentName; eventId: string })[];  // every finding, written or not
     signals: RiskSignal[];                                           // the written ones (score ≥ 0.4)
     decisions: Decision[];    // trigger, action, risk, the signals and rules used, reasoning, outcome, latency
     denied: Denial[];         // events refused after a stop, with the rule and the stop
     stepUps: StepUpResultEvent[];
     metrics?: Metrics;        // per chain, false positives, friction, loss prevented; only on a run that finished
   };
   ```
   `runId` = `<seed>-<mode>-<ISO time>`. Records go to `runs/<runId>.json` (git-ignored; demo runs get committed in M6).

**Failure policy:**
- **Input is validated before anything is scored.** Timestamps must parse and never go backwards; equal times keep their input order. Every account needs a profile, and every event a label (the runner answers step-ups from them).
- **Results are published only after the event is stored.** An event's findings and signals are staged, the event is stored, and only then do they reach the record and the signal store. A failed insert therefore leaves nothing from that event behind.
- **Any error stops the run.** That includes opening or closing the store. A record with `status: "failed"` and the first error is still written.
- **No silent fallback.** A run never falls back from ON to OFF, because that would corrupt the comparison.

`--meko off` makes no Meko calls. `--meko dry` runs the ON pipeline against `meko/dry.ts` and reports the calls a live run would make. `--meko on` runs that dry pass first, then the quota guard, then the live run, and appends what it sent to `runs/quota.jsonl`. An ON run prints one progress line per simulated day: a logger module wasn't needed.

## 6. Later milestones: contracts to honor

These are fixed now so that earlier code doesn't box them in; each lands in its own PR.

- **Config (M0):** `config.ts` reads `process.env` once, after `process.loadEnvFile()` when `.env` exists (Node built-in, no dotenv). Variables:
  - `MEKO_API_KEY`: required for ON mode
  - `MEKO_MCP_URL`, default `https://mcp.mekodata.ai/mcp`
  - `MEKO_API_URL`, default `https://api.mekodata.ai/api/v1`

  A missing or malformed value fails at startup with a message naming the variable, never its value. Both URLs must be https. The key is never logged.

  The working datapacks have fixed names (`tripwire-signals`, `tripwire-patterns`) and are looked up by name with `GET /datapacks?name=…`, so no datapack IDs need configuring.
- **Meko client (M0):**
  - MCP through `@modelcontextprotocol/sdk` (`StreamableHTTPClientTransport`). REST through `fetch`.
  - Both send `Authorization: Bearer` and `User-Agent: tripwire/<version>`, with a 10 s timeout. REST refuses any URL outside the API base, so the key never reaches another host. The knowledge-base upload's POST to storage (M1) is a separate request, sent without it.
  - **Retries depend on the operation**, because a write whose response is lost may still have been saved, and `memory_add` stores duplicates:

    | Operation | On 429 | On anything short of a clear refusal (a 5xx or JSON-RPC internal error, a timeout, a network error, an answer that can't be read) |
    | --- | --- | --- |
    | Reads: searches, gets, lists, document status | Retry | Retry |
    | Idempotent writes: `artifact_put` (keyed by content hash), datapack create (a repeat returns 409), `conversation_create` with a `session_id` and `conversation_add_message` with a `seed` (a repeat returns the same ID and stores nothing new, K10) | Retry | Retry |
    | `memory_add` | Retry (the request was refused, not processed) | **Never resend.** A receipt without a memory ID (`results[0].id`) is the same unknown outcome. Look for the signal's stable key (event ID + rule ID, in its text and metadata) in `memory_get_all`, which spends no search quota, a few times over about 5 s (K1 found a write on the first search, 1.1 s after it returned, in its one sample). A hit confirms the write. A miss proves nothing, because the first write may still be in flight, so the write stays unresolved: record the run as failed and stop. |
    | `memory_promote` (or REST `POST /promote-memories`) | Retry | Check the promoted list for the ID first; promote again only if it's absent. A repeat is harmless: it returns the ID in `not_found_ids` (K4). |

    Conversation writes always carry their dedupe key, so a retry stores nothing new. `seed` is the run ID plus the event ID (or the ledger day). `session_id` is a 32-hex hash of the run ID and the case key: Meko's docs say a hex `session_id` becomes the conversation ID unchanged, so the ID is known before the call (confirmed on 2026-11-24, K10). A retry still has a side effect: Meko may extract a memory from each call it accepts (K10's two sends of one turn left two), and hygiene deletes them. When all 3 attempts fail, the outcome is unknown, and the recovery depends on the write:
    - `conversation_create`: `conversation_get` on the known ID shows whether the conversation exists. If it doesn't, or that can't be checked, the run is recorded as failed.
    - `conversation_add_message`: the runner waits about 10 s for the background write (K10) and looks for the turn in that conversation with `conversation_get`. Found, the write is done. Not found, the run is recorded as failed, because C4 needs every trace.

    Retries use 3 attempts with exponential backoff and jitter (0.5 s → 4 s). They honor `Retry-After`, in seconds or as an HTTP date, over MCP too: the SDK drops a 429's headers, so the client reads them first. A wait longer than 60 s isn't shortened: the error is surfaced instead. Only a clear refusal fails at once: a 4xx other than 429, a JSON-RPC error other than an internal one, or a tool that answered with an error. Anything else may have been applied, including a success whose body can't be read and a `write-once` answer that isn't a JSON receipt. `meko/retry.ts` holds the policy: callers name the operation (`read`, `idempotent`, `write-once`), and a `write-once` call whose outcome is unknown throws `UnknownOutcomeError` instead of being resent.
  - Every response is checked by a type guard before use. An unexpected shape is an error, not a guess. So is an answer that carries `error`: Meko reports some failures inside a successful answer, such as `{"error": "conversation_id_required"}`.
  - Every call is counted for the quota ledger (R7).
- **ON signal store (M2, `signals/meko.ts`):** `memory_add` with `agent_id`, the run's conversation as `conversation_id`, one line of text naming every entity, and metadata (stable key, entities). Recall uses `memory_search` with `run_id` set to the run conversation, so a run only sees its own signals (K2). A result counts only if all three hold:
  - its ID was written by this run (provenance, R8);
  - it names the same entity, since the search also returns unrelated rows above its 0.2 similarity floor;
  - it falls inside the 72-hour window.

  An event gets at most one memory search, made when an agent or the decision agent first needs it, and shared by all of them: in ON mode they all see the same signals, so they would ask the same thing. The signals written on the event itself are added locally. The search carries the account's case conversation as `conversation_id`, so the portal shows it in that case's trace (K11). Every search becomes a `Retrieval` record (C3).

  **A7, waiting for new signals,** happens where it matters: when a search misses a signal this run wrote in the last 30 s that the event should see, it's repeated after 2 s and then 4 s. A miss after that is recorded as `timedOut` and the run goes on. An older miss is the search's ranking, not indexing, so it isn't retried. On seed 42 the dry run makes 273 memory searches.
- **Hygiene (M2, R5, R8):** an ON run starts by deleting every memory of the four detection agents and of `tripwire:decision` in its datapack (`memory_delete_all` per agent, repeated until `complete`). Meko extracts a memory from each trace or ledger turn's user input within about 30 s, under the conversation's agent ID (K6), and a retried call can be extracted again (K10). So the run ends by waiting at least 60 s after its last conversation call, retries included, and then deleting `tripwire:decision`'s memories again. The R8 audit then lists every memory in the datapack, deletes any this run didn't write, and lists again: anything left fails the run. The decision agent writes turns but never writes memories of its own. A run that fails before its end skips the audit, and the next run's start-of-run delete clears what it left.
- **Decision agent (M2, `agents/decision.ts`, pure):**
  - Triggers per C1: every account change (email, phone, password, payout method, 2FA), password reset, transfer and payout, a card charge of ₹10,000 or more, and any event with a signal ≥ 0.7. Everything else is allowed without review, with a one-line reason.
  - It sees the signals its mode allows, through the same `SignalStore`: in OFF mode only the owning agent's, earlier and on the event itself; in ON mode everyone's. Earlier ones are already filtered to the same account, device, IP or payee within 72 h.
  - Risk is the noisy-OR of the strongest signal per type. A tie goes to the newer signal, then the lower event ID, so the input order never changes a decision.
  - Policy: ≥ 0.8 BLOCK, 0.5–0.8 STEP-UP, else ALLOW. A known device plus travel alone is capped at STEP-UP: a BLOCK whose only signals are impossible travel, on a device in the profile. `knowledge/step-up-policy.md` states the same numbers, and a test checks it.
  - The reason is a template over the decision record, so nothing is generated text. `rulesApplied` lists the rules behind the signals used, then the policy rule (`policy.block`, `policy.step-up`, `policy.allow` or `policy.travel-cap`).
  - **Traces (`runner/trace.ts`):**
    - Each account gets one case conversation per run, opened at its first Meko call (`session_id` = hash of the run ID and `case:<account>`). `conversation_create` isn't counted in the quota (K8).
    - Each STEP-UP and BLOCK gets its own turn in the case (C4): the decision record as output, the reasoning, and a plan that ends with the outcome. Before it, two `knowledgebase_search` calls in `tripwire-patterns`, filed under the case, fetch the playbook passage and the policy passage it quotes (C3). ALLOWs get no quotes.
    - Every other event goes into the daily allow ledger, one line each with its reason, signals and searches (C5): unreviewed ALLOWs, reviewed ALLOWs with their risk, and events refused after a stop with the rule. A day is sent when the next one starts, in parts of at most 12,000 characters (K10 stored 13,149 whole). Seed 42 needs 53 conversation messages in all.
    - Every turn's user input is one of two fixed lines that state no facts (R8).
- **Dry run (M2, before the first ON run):** `--meko dry` runs the whole ON pipeline against an in-process stand-in for Meko (`meko/dry.ts`) and reports the conversation calls and searches the run would make. The stand-in answers with the shapes the live API gave in the week-1 checks, searches by ideal keyword match, and mines a memory from each turn as Meko does (K6), so the audit runs too. The quota guard and the PRD §9 ceiling are checked against these measured numbers, not estimates.
- **Outcomes (M2, `runner/outcomes.ts`):** R2 and R3. The runner answers a step-up from the labels: the owner passes and an attacker fails. A stop (a BLOCK or a failed step-up) locks the device that triggered it on every account (`lock.device`). It also makes the account refuse payments, password resets and account changes from any device outside its profile that hasn't passed a step-up on it (`lock.unverified-device`): that is the "verified history". A refused event is never scored or stored, since the app turns it away at the door. Prevention is computed from what the runner refused (PRD §8): a chain is prevented when its takeover event was refused, and stopped at the phase of its first refused event.
- **Quota guard (M2, `runner/quota.ts`):** every ON run appends what it sent to `runs/quota.jsonl`, in the same line shape as the spike's `runs/spike/attempts.jsonl`. The guard adds up both logs for the current UTC month into the three counters Meko caps on the Free plan (K8): conversation messages, memory searches and KB searches. An ON run refuses to start when the dry pass's counts plus 25% don't fit what's left. `shortcut:` the Free limits are hard-coded, and the month is the calendar month, since the reset day is unknown.
- **Learning loop (M3):** L1–L4 exactly as the PRD states. Each pattern gets its own approval conversation, a `memory_add` linked to it, `memory_promote`, and confirmation in the promoted list (K4). Patterns are found with `knowledgebase_search`; a hit with `metadata_filters.source: "memory"` is a learned pattern, and anything else is a playbook passage (K3). A promoted pattern can't be deleted (K7), so each evaluation run starts from a fresh patterns datapack (R5).

## 7. Testing

| Level | What | Where |
| --- | --- | --- |
| Unit | Each rule, positive and negative, against a PGlite store seeded with a few events | `agents/*.test.ts` |
| Unit | Store queries, including the no-future-data property | `store/store.test.ts` |
| Unit | `noisyOr`, routing, risk-rules rendering matches the committed file, the step-up policy states the code's thresholds | `agents/agents.test.ts`, `knowledge/render.test.ts` |
| Unit | Decision triggers, policy, travel cap, tie-breaking, reasoning; metrics from refusals | `agents/decision.test.ts`, `metrics.test.ts` |
| Integration | OFF replay of seed 42: completes, writes the planted scenarios' expected signals, stops each chain where the design's OFF column expects; locks and step-ups on a hand-built stream | `runner/replay.test.ts` |
| Generator | Determinism, size, chains, no attack-only values, traveler fixture, CLI | `generator/generate.test.ts` (done) |
| ON mode | The ON store, trace recovery after a lost answer, the R8 audit, the ledger, the quota guard, and a dry replay of seed 42, all against the stand-in | `signals/meko.test.ts`, `runner/trace.test.ts`, `runner/quota.test.ts`, `runner/replay.test.ts` |
| Live | ON mode against real Meko is run by hand (`--meko on`), never in tests or CI: it needs the key and spends quota. | |

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
| 6 | `feat/meko-client` | Config, MCP and REST clients with the retry policy, spike script for K1–K11 | M0, K9 | `main` |
| 7 | `docs/meko-spikes` | K1–K11 answers in `docs/spikes.md`; spec, design and API notes updated to match | K1–K11 | `feat/meko-client` |
| 8 | `docs/week1-followups` | K7, K8 and K11 answered in the portal; search quota corrected; M0 and M1 ticked | K7, K8, K11 | `main` |
| 9 | `fix/spike-private-fields` | The spike's saved answers also drop `promoted_by_*` and `uploaded_by_email` | | `main` |
| 10 | `feat/kb-upload` | Knowledge-base upload script | A5, C2 | `main` |
| 11 | `feat/decisions` | Decision agent, stops and step-ups, metrics, in OFF mode | C1–C3, R2, R3, §8 | `feat/kb-upload` |
| 12 | `feat/meko-on` | ON signal store, traces and allow ledger, hygiene audit, `--meko dry`, quota guard | A5–A7, C3–C5, R5, R7, R8 | `feat/decisions` |
| 13 | `docs/m2-results` | ON vs OFF table for seed 42 from the first live run | §8 | `feat/meko-on` |
| 14+ | M3 onward | Analyst agent, approvals and learnings; then M4–M6 per the plan | | |
