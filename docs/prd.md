# Tripwire: Product Requirements

| | |
| --- | --- |
| Status | v1, 2026-11-22 |
| Hackathon | ContextCon 2026, Theme 3 "Remember the Attacker" |
| Submission due | Jan 17, 2027, 11:59 PM PT (Jan 18, 1:29 PM IST); internal target Jan 15 |
| Related | [Build plan](plan.md) · [Technical design](design.md) · [Meko API notes](meko-api.md) |

## 1. Summary

Tripwire stops account takeovers in a payments app before money leaves. Four detection agents (login, device, transaction, support) each watch their own events and share risk signals through one Meko datapack. A decision agent reads those shared signals and returns ALLOW, STEP-UP or BLOCK. When an attack is confirmed, its pattern becomes a human-approved Meko learning, so the next attacker using the same playbook is stopped earlier. Every decision comes with a plain-English reason and a Meko trace.

### Challenge coverage

Every item in the official Challenge 03 brief, and where this PRD covers it.

| Challenge item | Where |
| --- | --- |
| **Objective:** share signals: login, device, transaction and support agents write to and read from shared memory | A1–A7 |
| **Objective:** connect the dots before the takeover completes | C1–C2; scenarios s1, s2, s4 |
| **Objective:** remember past attacks | L1–L4; scenario s5 |
| **Objective:** explain every block, step-up and allow through traces | C3–C5, U3, DOC2 |
| **Meko:** collective memory, signals immediately available to the other agents | A5, A7 |
| **Meko:** hybrid retrieval for similar past patterns | A6 |
| **Meko:** knowledge base of fraud playbooks and risk rules | A5, C2 (`knowledge/` docs) |
| **Meko:** decision traces showing every retrieval and memory behind a flag | C3, C4 |
| **Meko:** separate datapacks for raw signals and confirmed patterns | `signals` and `patterns` (§7) |
| **Outcome:** synthetic stream of up to about 2,000 events with planted takeovers | D1–D3.4, D6 |
| **Outcome:** only risk signals and confirmed patterns saved as memories | A5, L2, L4, R8 |
| **Outcome:** multi-agent detection system sharing memory through Meko | A1–A7, C1–C5 |
| **Outcome:** results: attacks caught before takeover, false positives, steps early for each | §8 |
| **Outcome:** trace walkthroughs for at least 3 decisions | DOC2 |
| **Encouraged:** the same agents without shared memory, for comparison | R4, §8 |
| **Suggested area:** cross-channel takeover (login + support + payment) | s2 |
| **Suggested area:** fraud rings across accounts | s4 |
| **Suggested area:** adaptive step-up | C2: a pattern match escalates; a known device plus travel caps at STEP-UP |
| **Suggested area:** analyst copilot that explains each alert | U3 alert view; Meko portal chat for questions; a local-model copilot is a Could |

## 2. Problem

- **A takeover is a chain of small steps:** guessed passwords, a login from a new device, a changed email, a payout. A different system sees each step: the login service, device fingerprinting, payments, the support desk.
- **Each system sees one weak signal.** On its own, a new device or a new payee is normal, because customers change phones and pay new people every day. Siloed rules either miss the chain or block real customers.
- **Lessons don't travel.** What an analyst learns from one incident stays in their head or in a ticket. The same attacker, a week later on another account, starts from zero.

Who has this problem: fraud and risk teams at payment apps, wallets and neobanks.

## 3. Goals and non-goals

| ID | Goal | Measured by |
| --- | --- | --- |
| G1 | Stop takeovers before money leaves | Chains stopped, steps early, ₹ loss prevented |
| G2 | Connect signals across agents as they happen | ON vs OFF gap on the cross-agent scenarios (s2, s4) |
| G3 | Remember attackers, with a human in control | s5 stopped earlier than s1; every learning has an approval |
| G4 | Explain every decision | Anyone can explain a decision from the alert view in under 2 minutes |
| G5 | Prove the value of shared memory | Meko ON vs OFF on the same held-out streams |
| G6 | Cost nothing to run | Meko Free plan, no paid APIs |

**Non-goals:**
- production deployment or scale
- real payment, login or support integrations
- real customer data or PII (all data is synthetic)
- training ML models
- paid LLM calls
- multi-tenant auth and roles
- streaming infrastructure such as Kafka
- a mobile app

### Decision: no LLM on the critical path

Meko is the hackathon's only hard requirement, and running Tripwire must cost nothing (G6).

- **Decisions are deterministic.** Each agent scores its events with documented rules and Postgres counts. Where Meko is on, it adds the signals other agents shared and the approved patterns. The decision agent combines everything into one risk score and applies policy thresholds. Production fraud engines work this way, because decisions need millisecond latency. It also makes every metric exactly reproducible.
- **The "why" comes from the decision record:** the signals used, the patterns matched, the rules applied, and a quoted passage from the knowledge-base playbook. Nothing is invented.
- **Analyst conversations still happen.** Case notes are saved as Meko conversation turns that other agents can find with `context_search`. To ask questions about a case, analysts use Meko's portal chat (WorkbenchLM).
- **Patterns are drafted from data:** the indicators a closed case shares (browser string, IP prefix, device, payee or bank account, order of signals, timing).
- **Optional extra:** a free local model through Ollama to polish explanations (Could priority). Nothing depends on it.
- **What we give up:** `track_token_usage` and a "tokens per decision" metric. We report Meko calls and context returned per decision instead.

## 4. Users and stories

| Persona | Needs |
| --- | --- |
| Fraud analyst (primary) | Sees alerts as they happen, understands why each one fired, confirms incidents, approves patterns |
| Risk lead | Fewer losses without blocking good customers; trusts numbers, not anecdotes |
| Customer (indirect) | Isn't blocked for travelling or buying a new phone |
| Hackathon judge | Sees collective memory, traces and results within a 5-minute video or a short click-through |

| ID | Story | Done when | Priority |
| --- | --- | --- | --- |
| S1 | As an analyst, I watch events stream in and see an attack light up signals from several agents | s2 is stopped before its ₹1,80,000 transfer, live in the feed | Must |
| S2 | As an analyst, I open an alert and see why it fired | One screen shows the decision, each agent's signal with time and evidence, matched patterns, rules with a quoted playbook passage, and a link to the Meko trace | Must |
| S3 | As an analyst, I review the pattern drafted from a stopped attack and approve it | The approved pattern appears in the patterns library and in Meko Collective Memory | Must |
| S4 | As a risk lead, I see the same attacker stopped earlier the second time | s5 is stopped at an earlier step than s1, and its trace cites the learned pattern | Must |
| S5 | As a risk lead, I compare Meko ON and OFF | Metrics page shows both runs side by side | Must |
| S6 | As a travelling customer, I get a check instead of a block | The s6 traveler gets STEP-UP, passes it, and is never BLOCKed | Must |
| S7 | As an analyst, I add a note to a case and other agents can use it | The note is a Meko conversation turn that `context_search` finds | Should |
| S8 | As a judge, I replay a recorded run in the browser without any keys | A public demo link replays a recorded run | Should |

## 5. How it works

```
Generator ──► Runner ──► Detection agents ──► Decision agent ──► Outcome
 (seeded       (replays    login · device ·     risk + policy:      BLOCK freezes the account;
  events +      events in   txn · support        ALLOW / STEP-UP /   STEP-UP sends an OTP the user
  labels)       time order) rules + Postgres     BLOCK, traced       passes and the attacker fails
                            + Meko recall        in Meko                 │
                                 ▲                                       ▼
                                 └── approved patterns ◄── Analyst agent drafts pattern + report
                                     (Meko learnings)      ◄── human approves
```

1. The generator writes a seeded stream and separate ground-truth labels (done).
2. The runner replays events in time order: fast for metrics, paced for the demo.
3. Each event goes to the agent that owns it. The agent scores it with its rules and Postgres counts. If the event looks suspicious, the agent recalls related signals and approved patterns from Meko. It writes a risk signal to Meko when the score is high enough.
4. The decision agent runs on sensitive events and high-risk signals. It gathers the signals, patterns and policy, computes risk, decides, and saves the decision with its reasoning as a Meko trace.
5. The runner applies the outcome and tracks account state.
6. When a case closes, the analyst agent drafts a candidate pattern and an incident report. A human approves the pattern, and Meko promotes it to a learning.
7. The dashboard shows all of it, live or from a recorded run.

## 6. Functional requirements

Priority: **M** = Must, **S** = Should, **C** = Could.

### Data

| ID | Requirement | Pri | Status |
| --- | --- | --- | --- |
| D1 | Seeded stream: at most 2,000 events (trimmed to fit), 150 accounts, 14 days. Rejects seeds outside 0–4294967295 and totals that can't fit the planted events. | M | Done |
| D2 | Ground-truth labels in a separate file the agents never read | M | Done |
| D3 | Six planted scenarios: credential stuffing (s1), support-desk reset (s2), card testing (s3), fraud ring (s4), repeat attacker (s5), innocent traveler (s6) | M | Done |
| D3.1 | "Low and slow" s1/s5: 2–3 attempts per account across 12–15 accounts, from residential IPs in Indian cities and a rare but plausible browser string, at a steady ~40 s cadence. The fixed rules can't catch s1 at the login. At s5's login, the browser string, the cadence and the spray running at the same time are observable, so the learned pattern can catch it there. The mule account only appears at the payout. | M | Done |
| D3.2 | No attack-only values. Benign look-alikes (decoys) share each suspicious trait: the rare browser string, new bank accounts, tiny and very large payments, support calls verified by security questions (KBA), resets via support. A test checks, for each seed, that every field value seen in an attack also appears in benign traffic. | M | Done |
| D3.3 | Evaluator-only labels: chain ID and role (victim or probe) on every attack event. Steps are phases that several events can share. | M | Done |
| D3.4 | Traveler fixture: the device is in the account profile, the user was last seen at home on it 2 hours before the trip, and no other home event falls inside the trip | M | Done |
| D4 | Postgres store with device↔account and payee↔account tables for agent queries. The runner inserts each event as it replays, so a query can only see events already processed. Meko AMP if the Free plan allows it, otherwise PGlite with the same SQL. | M | To do |
| D5 | Held-out seeds (101–105) kept out of tuning | M | To do |
| D6 | Account profiles (`accounts.json`): registered phone, home city, and the devices and payees each account had before the stream starts. Agents may read them, as a real payments app knows its customers. | M | Done |

### Detection agents

| ID | Requirement | Pri |
| --- | --- | --- |
| A1 | **Login agent** (`login`, `password_reset`): failure bursts, failures then success, impossible travel, login soon after a support-desk reset (scored ≥ 0.7, so that login always gets a review) | M |
| A2 | **Device agent**: sees every event with client fields (logins, resets, account changes, transactions) alongside the agent that owns it. Support calls and OTP results have no client fields. Signals: device not in the account's profile or history, one device shared across accounts, rare browser string, new device right after a reset. | M |
| A3 | **Transaction agent** (`transaction`): card testing (burst of tiny charges across merchants), high-value transfer to a new payee, payout to a new bank account, amount far above the account's history | M |
| A4 | **Support agent** (`support_contact`, `account_change`): weak identity check on a reset or email change, caller phone or location that doesn't match the account profile, sensitive change soon after a new-device login | M |
| A5 | Scores come from documented rules. The same thresholds live in code and in the knowledge base (`risk-rules.md`). A signal is written to Meko only when its score is ≥ 0.4, as one line of text naming the entities, plus metadata. | M |
| A6 | When its own score is ≥ 0.2, an agent recalls shared signals for the same account, device, IP or payee, plus approved patterns, using Meko's hybrid (semantic + keyword) search. A retrieved signal counts only if it names the same account, device, IP or payee and falls inside the 72-hour window. A pattern match counts only on indicators visible at that event, and adds a `pattern_match` signal that names the pattern. | M |
| A7 | Signals are immediately available: a signal one agent writes must be retrievable by the others before the next event that depends on it, including events on other accounts that share its device or payee. K1 tests this end to end with an expected memory ID and a time limit. In ON mode the runner waits up to that limit and records a timeout as an outcome. | M |

### Decision agent

| ID | Requirement | Pri |
| --- | --- | --- |
| C1 | Runs on every sensitive event (credential or payout change, password reset, transfer, payout, card charge ≥ ₹10,000) and on any new signal ≥ 0.7. All other events are allowed without review, each with a one-line reason. | M |
| C2 | Risk = noisy-OR of the strongest signal of each type in the last 72 hours. Policy: risk ≥ 0.8 is BLOCK, 0.5–0.8 is STEP-UP, anything lower is ALLOW. A known device plus travel alone is capped at STEP-UP. The policy text lives in the knowledge base (`step-up-policy.md`) and is mirrored in code. | M |
| C3 | Decision record: action, risk, signals used, patterns matched, rules applied, quoted passages from the matching fraud playbook and from the step-up policy (with document IDs), plain-English reason, latency. It also holds a retrieval record for every Meko search any agent made for this event: tool, datapack, query, returned IDs, used IDs, errors. | M |
| C4 | Trace: one Meko conversation per case. Every STEP-UP and every BLOCK gets its own `conversation_add_message`, with the decision record as output plus `reasoning` and `plan`. The decision agent's searches pass the case's `conversation_id`, so the portal can show them under it (K11). The record lists every search either way. The dashboard links to the trace. | M |
| C5 | Allow ledger: one trace turn per simulated day lists every ALLOW, reviewed or not, by event ID, with its reason, the signals behind it and any searches made for it. Every ALLOW is therefore explained in a Meko trace without a turn of its own. | M |

### Runner

| ID | Requirement | Pri |
| --- | --- | --- |
| R1 | Replays events in time order. `--mode fast` for metrics, `--mode paced --speed N` for the demo. | M |
| R2 | Stops are final for the attacker. After a BLOCK or a failed STEP-UP on an account, later events from the device that triggered it are denied for the rest of the run. So are payments and credential changes from any device not in the account's profile or verified history. Each denied event is logged with the rule that denied it. | M |
| R3 | The runner is the world simulator. It decides OTP outcomes from the labels (the real owner passes; an attacker fails unless the scenario gave them the phone) and writes a `step_up_result` event. Agents never read labels, scenario IDs or steps. | M |
| R4 | `--meko on\|off`. OFF means no Meko at all: each decision sees only the owning agent's own signals, with no knowledge base and no learnings. Rules and thresholds stay the same. | M |
| R5 | Run isolation. Each ON run starts with an empty `signals` datapack. Each evaluation run also starts with zero learned patterns. Promoted patterns can't be deleted through the API (K7), so each evaluation run gets a fresh `patterns` datapack. A probe search before the run must return no learned pattern. | M |
| R6 | Each run is saved to `runs/<id>.json`: signals, decisions, cases, patterns, metrics, Meko call counts | M |
| R7 | Quota guard: counts Meko calls and refuses an ON run that would go over the remaining monthly quota | M |
| R8 | Memory hygiene: only risk signals and confirmed patterns are saved as memories. Trace and note turns use a fixed, fact-free user turn; the details go in the output and `reasoning`. Agents trust only memories whose IDs the runner wrote in this run, plus approved pattern IDs. After each ON run, an audit waits for Meko's background extraction to finish and pages through every memory. It deletes anything not on those ID lists, repeating `memory_delete_all` until it reports complete, and fails the run if anything is left. | M |

### Learning loop

| ID | Requirement | Pri |
| --- | --- | --- |
| L1 | When a case closes (stopped, or money lost), the analyst agent extracts the indicators the case shares and drafts a candidate pattern | M |
| L2 | The candidate pattern and the incident report are saved as Meko artifacts, not memories, so nothing unconfirmed enters memory. Each review adds a new version. Artifacts are fetched by content hash, so each case keeps its own list of version hashes. | M |
| L3 | Approve or reject in the dashboard. Batch runs approve confirmed attacks automatically 24 simulated hours after the case closes, standing in for an analyst who checked the case. | M |
| L4 | Approving creates an approval conversation in `patterns`, saves the pattern with `memory_add` linked to it, then promotes it with `POST /promote-memories`. Success is confirmed by finding the ID in the promoted list. Retries are bounded, and approving an already-promoted pattern does nothing. Rejecting only marks the draft rejected. Agents therefore only ever retrieve approved patterns. | M |
| L5 | Analyst case notes saved as conversation turns on the case. Depends on K6: what Meko extracts from them. | S |

### Dashboard

| ID | Requirement | Pri |
| --- | --- | --- |
| U1 | Live feed of events, colored by risk, with text labels | M |
| U2 | Account timeline: every event and signal for one account, attack steps highlighted | M |
| U3 | Alert view: decision, why, signals by agent, patterns, rules, link to the Meko trace | M |
| U4 | Approval queue and patterns library, showing where each pattern was reused | M |
| U5 | Metrics page: Meko ON vs OFF | M |
| U6 | Replay: re-run a recorded stream to show the repeat attacker stopped earlier | S |
| U7 | Public static demo built from recorded runs, with no keys in the page | S |
| U8 | Case notes panel | S |
| U9 | Retrieval quality panel from Meko self-learning (`selflearning_status`) | C |

### Docs and submission

| ID | Requirement | Pri |
| --- | --- | --- |
| DOC1 | README: problem, architecture diagram, how Meko is used, results table, setup | M |
| DOC2 | At least 4 trace walkthroughs: s2 stopped at the reset, s5 pattern reuse, s6 STEP-UP then ALLOW, and one routine ALLOW from the ledger. One of them shows a fraud-playbook passage with its document ID. | M |
| DOC3 | Methodology: ON/OFF definition, held-out seeds, simulated approval, limits | M |
| DOC4 | Demo video under 5 minutes | M |

## 7. How Meko is used

The judges weight Meko use at 30% and ask for every part of it. Each row below is a requirement above.

| Meko part | Use in Tripwire | Calls |
| --- | --- | --- |
| Memory | Risk signals shared across agents | `memory_add`, `memory_search`, `memory_delete_all` (run reset and hygiene) |
| Learnings | Patterns a human approved, promoted to Collective Memory | `memory_add` in `patterns` on approval, then `POST /promote-memories` |
| Knowledge base | Fraud playbooks (the matching one quoted in each decision), risk rules, step-up policy, approved patterns | REST upload, `knowledgebase_search`, `context_search` |
| Conversations | One case file per alert: decisions and analyst notes | `conversation_create`, `conversation_add_message` |
| Decision traces | `reasoning` and `plan` on every STEP-UP and BLOCK, searches attributed to the case, and a daily allow ledger that explains every ALLOW | `conversation_add_message`, `conversation_id` on searches |
| Artifacts | Incident reports and candidate pattern drafts, versioned | `artifact_put`, `artifact_get` |
| Postgres (AMP) | Raw events and the device/payee graph that agents query. If AMP isn't on the Free plan, we use PGlite locally and say so in the submission. | SQL |
| Datapacks | `signals` (cleared every run) and `patterns` (kept, reset between evaluation runs) | REST |
| Self-learning | Retrieval quality on the metrics page (Could) | `selflearning_status` |

**How sharing works:** every agent uses the same Meko account, each under its own agent ID, and `memory_search` returns all of their memories in a datapack. That is how signals are shared between agents. Meko's Collective Memory holds only the approved patterns. The submission describes both this way.

## 8. Evaluation

**Definitions**
- **Attack chain:** the planted steps against one victim account. There are 9: s1, s2, s3, the five s4 accounts, and s5. Probe accounts, attacked but never taken over, are not chains, and stopping them earns no credit.
- **Prevented:** the chain's takeover event was denied, so the money never left. This is computed from what the runner actually executed.
- **Caught early:** prevented by a stop at least one phase before the takeover event.
- **Steps early:** takeover phase minus the phase where the chain was stopped. 0 means the payment itself was denied. Steps count phases, not events: a run of failed logins is one phase.
- **False positive:** a BLOCK on a legit event. **Friction:** a STEP-UP on a legit event.
- **Loss prevented:** the ₹ amount of takeover steps that never executed.

**Method**
- Tune rules and thresholds on seed 42 only.
- Report on held-out seeds 101–105: one OFF run and one ON run each.
- Re-run one ON seed to confirm results are stable.
- Analyst approval is simulated in batch runs (L3).
- Evaluation runs happen in January, after the monthly Meko quota resets.
- Could: one "ON without learnings" run on a held-out seed, to separate the effect of shared signals from learned patterns.
- Limitation: the scenario structure is fixed. Seeds vary timing, amounts, entities and background traffic.

**Targets** (Meko ON, held-out seeds). Actual numbers are reported whether or not they meet these:
- At least 8 of 9 chains prevented, and OFF prevents fewer.
- At least 3 chains caught early (s1, s2, s5), and more than OFF.
- More steps early on average than OFF.
- s5 stopped at an earlier step than s1, with the learned pattern cited in its trace.
- s2 stopped at an earlier step than in OFF.
- No BLOCK on the s6 traveler, in either mode.
- False-positive BLOCKs at most 0.5% of legit sensitive events. Friction rate reported.
- Every decision, including every ALLOW, is explained in a Meko trace: its own turn, or the daily allow ledger.
- No memories other than signals and approved patterns after a run.

**Also reported:**
- for each of the 9 chains, the step where it was stopped and how many steps early, ON and OFF
- decision latency (p50/p95)
- Meko calls and context returned per decision
- match quality bands

## 9. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Cost | $0: Meko Free plan, no paid APIs |
| Meko quota | Per ON run: at most 120 conversation calls (STEP-UP and BLOCK traces, case files, 14 allow-ledger turns) and 800 searches, checked by the M2 dry run before the first ON run. The Free plan allows 1,000 memory searches and 1,000 KB searches a month (K8), so it fits about one full ON run a month; the owner upgrades to Meko Standard when it runs out. Readers can still reproduce an ON run on a Free account. All 10 lifetime datapack slots: the default one and `tripwire-spike` (already used), 2 working ones, and 6 fresh `patterns` datapacks, because promoted patterns can't be deleted through the API (K7). None is spare. |
| Reproducibility | Same seed and mode give the same decisions. Any variance from Meko indexing timing is measured and reported. |
| Security | The Meko key lives in `.env` on the server side only. The static demo has no keys. All data is synthetic. |
| Speed | A fast-mode run finishes in under 10 minutes |
| Accessibility | Keyboard navigation, colorblind-safe risk colors that also carry text labels, WCAG AA contrast |
| Platforms | Windows, macOS, Linux; Node 22 or newer (Node 20 reached end of life in April 2026) |

## 10. Assumptions and constraints

- Solo build over about 8 weeks, with lower capacity over the holidays (Dec 24 – Jan 1).
- Meko Free plan. If quota runs short, ask for credits on the Meko Discord.
- Node and TypeScript throughout; React + Vite for the dashboard.

## 11. Risks and open questions

**Unknowns to check in week 1** (details in [plan.md](plan.md#week-1-checks); answers in [spikes.md](spikes.md)):

| ID | Unknown | Fallback |
| --- | --- | --- |
| K1 | Whether a signal written by one agent is retrieved, by its expected ID, when another agent handles a linked event on a different account, and how long that takes | Pace the replay to the measured delay; record timeouts as outcomes |
| K2 | Run isolation: `memory_delete_all` per agent, or a `run_id` filter | Clear the datapack between runs by hand |
| K3 | Which search returns promoted patterns best: `knowledgebase_search` or `memory_search` | Use `memory_search` on `patterns`, which only ever holds approved patterns |
| K4 | What promotion needs: the memory must be linked to a conversation and indexed, and an already-promoted ID also comes back in `not_found_ids` | Link to an approval conversation, confirm via the promoted list, bounded retries |
| K5 | AMP Postgres on the Free plan | PGlite locally, same SQL |
| K6 | Which memories Meko extracts from trace turns, under which agent ID, and how long extraction takes | Fact-free user turns; the end-of-run audit deletes anything else (R8) |
| K7 | Whether promoted patterns can be deleted between evaluation runs | A fresh `patterns` datapack per evaluation run (up to 6 slots) |
| K8 | How much quota a run uses, and the day the monthly quota resets | Develop in OFF mode; ask for credits on Discord; evaluate after the reset |
| K9 | Connecting to Meko's MCP server from Node with auth and User-Agent headers | Use REST wherever an endpoint exists |
| K10 | Size limit of one conversation message (the allow ledger) | Split the ledger by half-day |
| K11 | Searches tagged with a `conversation_id` show up in that conversation's trace, including searches in the other datapack (`patterns`) | The decision record lists every search either way (C3) |

**Other risks**

| Risk | Mitigation |
| --- | --- |
| Scope creep | Must/Should/Could priorities and a cut list in the plan |
| Holiday weeks | The lightest milestone (Dashboard I) falls in that week; submit target is 2 days before the deadline |
| "The scenarios are tuned to the system" | Held-out seeds, decoys so no field value gives an attack away, an OFF baseline, and an honest limits section |
| Judges can't run Meko themselves | Static demo from recorded runs; OFF mode runs with no account |

## 12. Glossary

| Term | Meaning |
| --- | --- |
| Signal | One agent's risk judgment about one event, with a score from 0 to 1 and the entities involved |
| Pattern | A description of an attacker's tactics drafted from a closed case |
| Learning | A pattern a human approved, promoted to Meko Collective Memory |
| Case | Everything about one alert on one account; one Meko conversation |
| Chain | The planted attack steps against one victim account |
| Phase | One stage of a chain: probing, account access, credential change, cash-out. Several events can share a phase. |
| Probe | Attacker traffic against an account that isn't the chain's victim (for example, the spray in s1) |
| Decoy | A benign customer action that shares one suspicious trait with an attack |
| STEP-UP | An extra check, an OTP to the registered phone, before the action goes through |
| Takeover step | The event where money leaves the account |
