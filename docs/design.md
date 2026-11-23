# Tripwire technical design

What to build and why is in the [PRD](prd.md); when, in the [build plan](plan.md). This file covers how.

## Repo layout

Two npm workspaces. Everything except the UI lives in one engine package, so no shared-types package is needed: the dashboard imports types from the engine.

```
context-con/
  package.json              workspaces: packages/*
  AGENTS.md, CLAUDE.md      instructions for coding agents
  packages/
    engine/src/
      types.ts              events, labels, account profiles (signals, decisions and patterns come next)
      generator/            seeded stream: rng, world, scenarios, decoys, background, generate, index (CLI)
      meko/                 mcp.ts (memory, knowledge base, conversations), rest.ts (datapacks, uploads, artifacts, promotion)
      db/                   Postgres store, filled as the runner replays (AMP if the Free plan allows it, else PGlite)
      agents/               login.ts, device.ts, txn.ts, support.ts, decision.ts, analyst.ts
      run.ts                world simulator: replays events, applies outcomes, --meko on|off, writes runs/<id>.json
      metrics.ts            scores a run against the labels
      server.ts             Hono + SSE for the dashboard; approve/reject patterns; holds the API key
    dashboard/              React + Vite: feed, timeline, alert "why", patterns, metrics, replay
  knowledge/                fraud playbooks, risk rules, step-up policy (.md) → `patterns` knowledge base
  data/                     events.jsonl, labels.json, accounts.json (seed 42 committed)
  runs/                     recorded runs, so replay and metrics cost no Meko quota
  docs/                     prd.md, plan.md, design.md, meko-api.md, walkthroughs
```

## Who does what

Nothing on this list calls an LLM (see the PRD's decision). Every decision is deterministic, so runs are free and reproducible.

| Component | How it decides | Meko calls (ON mode) |
| --- | --- | --- |
| Login / Device / Txn / Support agents | Rules over their own events, plus Postgres counts and the account profiles. The device agent also sees every event that has client fields, alongside its owning agent. When their score is ≥ 0.2 they recall shared signals and approved patterns. A recalled signal counts only on an entity match inside the 72-hour window. | `memory_add` a **risk signal** when score ≥ 0.4. `memory_search` by account, device, IP or payee; pattern search on `patterns` (tool chosen by K3). Every search is recorded. |
| Decision agent | Runs on every sensitive event and on any signal ≥ 0.7. Risk = noisy-OR of the strongest signal per type in the last 72h: ≥ 0.8 BLOCK, 0.5–0.8 STEP-UP, else ALLOW. Writes the "why" from the decision record, quoting the matching fraud playbook and the step-up policy. Flagged decisions get their own trace turn; every other ALLOW goes into a daily allow ledger. | `memory_search` (signals) and `knowledgebase_search` (playbook and policy passages, patterns), each with the case `conversation_id`; `conversation_create` / `conversation_add_message` with a fact-free user turn, the decision record as output, `reasoning` and `plan` |
| Analyst agent | When a case closes, extracts the indicators the case shares (browser string, IP prefix, device, payee or bank, signal order, timing) into a pattern template, and writes an incident report. | Candidate pattern and incident report → `artifact_put` (no memory until approved; the case keeps its list of version hashes). Approve → approval conversation in `patterns`, `memory_add` linked to it, `POST /promote-memories`, then confirm in the promoted list. Reject → the draft is marked rejected. |

Datapacks:
- `signals`: signals, case conversations and the allow ledger. Cleared at the start of every ON run.
- `patterns`: playbooks, rules, policy, and approved patterns, which are its only memories. Reset between evaluation runs.

### Meko ON vs OFF

- **ON:** agents share signals through `signals`, recall approved patterns from `patterns`, and the decision agent quotes the knowledge base.
- **OFF:** no Meko calls at all. Each agent keeps its own signals in process. A decision sees only the signals of the agent that owns the event (support owns account changes, transactions own payments, and so on). No knowledge base, no learnings.
- **Both:** same rules, thresholds, Postgres counts, profiles and policy.
- **What OFF still has:** the device agent's own view of which accounts share a device, because device history is its own data. OFF loses the other agents' signals and the learned patterns. An optional "ON without learnings" run separates those two effects.

### Runner rules

- **World simulator:** the runner may read the labels, but only to simulate the world: who holds the phone when an OTP is sent. Agents never see labels, scenario IDs or steps; they see only events, profiles and the `step_up_result` events the runner writes.
- **No future data:** each event is inserted into Postgres when it is replayed, so no query can see a later event.
- **Stops are final for the attacker:** after a BLOCK or a failed STEP-UP, later events from the device that triggered it are denied. So are payments and credential changes from devices not in the account's profile or verified history.
- **Prevention is measured, not assumed:** a chain counts as prevented only if the runner actually denied its takeover event.

## Data

Three files per seed, written by `npm run generate`:

| File | Who reads it |
| --- | --- |
| `events.jsonl` | Agents, one event at a time through the runner |
| `accounts.json` | Agents: what the app knows about each customer before the stream starts |
| `labels.json` | The runner (OTP outcomes only) and `metrics.ts`. Never the agents. |

```ts
// Full definitions: packages/engine/src/types.ts
type Base = { id: string; ts: string; accountId: string };           // "evt_000123", ISO-8601 UTC, "acc_0042"
type Client = { ip: string; geo: { country: string; city: string }; deviceId: string; userAgent: string };

type TripwireEvent = Base & (
  | Client & { kind: "login"; success: boolean; method: "password" | "otp"; failureReason?: "bad_password" | "locked" }
  | Client & { kind: "password_reset"; channel: "email" | "sms" | "support" }
  | Client & { kind: "account_change"; field: "email" | "phone" | "password" | "payout_method" | "2fa_off"; channel: "web" | "app" | "support" }
  | { kind: "support_contact"; channel: "phone" | "chat"; intent: "reset_password" | "change_email" | "other";
      callerPhone: string; callerGeo: { country: string; city: string };          // phone calls have no client fields
      verification: { method: "kba" | "otp" | "none"; passed: boolean } }
  | Client & { kind: "transaction"; type: "card_charge" | "transfer" | "payout"; amountMinor: number; currency: "INR";
      merchantId?: string; merchantCategory?: string; payeeId?: string; payeeIsNew?: boolean; status: "approved" | "declined" }
  | { kind: "step_up_result"; passed: boolean }   // written by the runner when a STEP-UP is answered
);

type AccountProfile = {
  id: string; registeredPhone: string; home: { country: string; city: string };
  knownDevices: { id: string; userAgent: string }[]; knownPayees: string[]; bankPayee: string;
};

type Label = {
  eventId: string;
  scenario: "normal" | "s1_cred_stuffing" | "s2_support_reset" | "s3_card_testing" | "s4_fraud_ring" | "s5_repeat_attacker" | "s6_traveler";
  attack: boolean;
  chainId?: string;           // "s1", "s2", "s3", "s4-1"…"s4-5", "s5"
  role?: "victim" | "probe";  // probe = attacker traffic against an account that isn't the chain's victim
  step?: number;              // phase, 1-based; several events can share one
  takeoverStep?: boolean;     // the event where money leaves
};
```

```ts
type RiskSignal = {
  agent: "login" | "device" | "txn" | "support";
  accountId: string; eventId: string; ts: string;
  type:
    | "credential_stuffing" | "failures_then_success" | "impossible_travel" | "login_after_support_reset" // login
    | "new_device" | "shared_device" | "rare_user_agent" | "new_device_after_reset"                     // device
    | "card_testing" | "high_value_new_payee" | "payout_new_bank" | "amount_anomaly"                    // txn
    | "weak_verification" | "caller_mismatch" | "sensitive_change"                                     // support
    | "pattern_match";                                                                                   // any agent
  score: number;          // 0..1
  entities: { ip?: string; deviceId?: string; merchantId?: string; payeeId?: string };
  evidence: string;       // one sentence
  patternId?: string;     // set on pattern_match
};
// Sent to memory_add as one line, so keyword and entity boosts work:
// "[signal][device] acc_0042 shared_device 0.82 dev_9f3a seen on 5 accounts in 48h (evt_000913, 2026-11-03T10:22Z)"

type Retrieval = { agent: string; tool: string; datapack: string; query: string; returnedIds: string[]; usedIds: string[]; error?: string };

type Decision = {
  id: string; accountId: string; triggerEventId: string;
  action: "ALLOW" | "STEP_UP" | "BLOCK";
  risk: number;           // noisy-OR, 0..1
  signalsUsed: string[]; patternsMatched: string[]; rulesApplied: string[];
  quotes: { documentId: string; text: string }[];  // matching playbook + step-up policy (ON only)
  retrievals: Retrieval[];                          // every Meko search any agent made for this event
  reasoning: string;      // the plain-English "why", generated from the fields above, also sent to Meko
  conversationId?: string; latencyMs: number;
};
```

## Planted scenarios

At most 2,000 events from 150 accounts over 14 days. Each planted story gets its own accounts, and background traffic is trimmed to fit. The expected outcomes are hypotheses, confirmed or corrected while tuning on seed 42 (M2–M3).

| Chain | Phases | Expected with Meko ON | Expected with Meko OFF |
| --- | --- | --- | --- |
| s1 | **1:** 2–3 failed logins on each of 15 probe accounts and 2 on the victim, ~40 s apart, overnight, from residential IPs in Indian cities, all with one rare Linux browser string. **2:** success on a new device. **3:** email change. **4:** payout of ₹80–99k to a new bank account (the mule). | Stopped at phase 3: the login and device signals reach the email-change decision (1 step early) | The payout is stopped at best, by the transaction agent alone (0 early) |
| s2 | **1:** a support call passes KBA from a phone that isn't on file. **2:** password reset via support. **3:** new-device login. **4:** ₹1,80,000 to a new payee. | Stopped at phase 2: the support agent's signals reach the reset decision, and the OTP goes to the real owner, so the caller fails (2 early). Backup: the phase-3 login is always reviewed (A1). | Transfer stopped at best (0 early) |
| s3 | **1:** six ₹1–₹10 charges at different merchants, some declined. **2:** a ₹45,000 electronics purchase. | Purchase stopped (0 early) | Same: the transaction agent sees it alone |
| s4-1…s4-5 | **1:** login from one shared device. **2:** ₹8–15k to the same new payee. The five accounts are about 10 h apart. | s4-2…s4-5 stopped at the transfer, because the device agent's shared-device signal reaches the decision (0 early). s4-1 is missed. | Missed: each transfer looks normal to the transaction agent |
| s5 | s1's attacker, 7 days later, on 12 probe accounts and a new victim. Same browser string, cadence and mule account; new IPs and devices. | Stopped at phase 2. The approved s1 pattern matches what is visible at the login: the browser string, the cadence, the spray running at the same time (2 early). | Same as s1 |
| s6 (not a chain) | Seen at home on their usual phone, then 2 h later in Bangkok on the same phone, with normal spending | Impossible-travel fires. The known device caps it at STEP-UP, which they pass, then ALLOW. | Same |

"Prevented" means the runner denied the takeover event. "Steps early" counts phases, not events: the takeover phase minus the phase where the chain was stopped.

**Visible when:** the mule account only appears at s1/s5's payout, so the s5 pattern match at the login must rely on the browser string, the cadence and the concurrent spray.

### Decoys

Benign customers who each share one suspicious trait with an attack. They exist so that no single field value gives an attack away. A test checks, for every seed, that each value seen in an attack also appears in benign traffic.

| Decoy | Looks like |
| --- | --- |
| 3 customers who already own a Linux desktop with the rare browser string; one mistypes twice before logging in | s1/s5's browser string |
| 1 customer with a new laptop using that browser string: 2 failed logins, then success, in daytime with no spray | s1/s5's login, minus the context |
| 3 customers who add a new bank account and pay out to it, one for ₹80–99k | s1/s5's payout |
| 2 password resets via support after a KBA check, one from another phone in another city; both then log in on a known device | s2's first two phases |
| An email change via support chat after KBA, an email change on the web, and a general KBA call | s1's phase 3, s2's support call |
| ₹1.2–2L to a new payee, ₹60k–1.5L to a known payee, two purchases of ₹25–70k, an ₹80–99k payout to their own bank | s2's transfer, s3's purchase, s1's payout amount |
| One customer adding a card to three apps (three ₹1–₹2 checks in minutes), plus three single ₹1–₹10 checks | s3's probing charges |

Background traffic also mixes in runs of 2–3 failed logins, KBA support calls, switches to a new bank account, and tiny and large payments.

## Still to check in week 1

The unknowns (K1–K11) and how each is tested are in the [build plan](plan.md#week-1-checks).
