# Tripwire: Build Plan

| | |
| --- | --- |
| Status | v2, 2026-11-23 (reworked after the first review) |
| Internal target | Submit by **Jan 15, 2027** |
| Hard deadline | Jan 17, 2027, 11:59 PM PT (Jan 18, 1:29 PM IST) |
| Related | [PRD](prd.md) · [Technical design](design.md) · [Meko API notes](meko-api.md) |

Requirement IDs (D1, A1, C1, …) refer to the [PRD](prd.md). In the tables, **You** marks steps only you can do (accounts, sign-ups, personal details); everything else is build work.

**What changed in v2:**
- The riskiest pieces now come first. M2 is a thin live slice (s2 stopped in Meko with its full trace), and M3 proves the s1→s5 learning path. Both land before any dashboard work.
- Full evaluation moves to January, after the monthly Meko quota resets, and away from the holiday weeks.
- The quota guard is a Must from M2.

## Milestones

| Milestone | Dates | Exit criteria |
| --- | --- | --- |
| [M0 Foundations](#m0-foundations-nov-2229) | Nov 22–29 | Generator v2 done; both datapacks exist; K1–K11 answered in `docs/spikes.md` |
| [M1 Data and agents, OFF mode](#m1-data-and-agents-off-mode-nov-30dec-6) | Nov 30–Dec 6 | An OFF run on seed 42 writes signals and a run file; a test proves no query sees an event before it's replayed |
| [M2 Thin live slice](#m2-thin-live-slice-dec-713) | Dec 7–13 | In a live ON run, s2 is stopped at the reset and its trace, with every search, is in the Meko portal. A stopped chain's payment is denied. The hygiene audit passes. ON vs OFF table for seed 42. |
| [M3 Memory pays off](#m3-memory-pays-off-dec-1420) | Dec 14–20 | In ON, s5 is stopped at its login, citing the s1 pattern, confirmed in the promoted list. Without the pattern it isn't. The decoys that share its browser string aren't stopped. |
| [M4 Dashboard I](#m4-dashboard-i-dec-2127) | Dec 21–27 | A paced run can be watched live in the browser |
| [M5 Dashboard II](#m5-dashboard-ii-dec-28jan-3) | Dec 28–Jan 3 | The metrics page shows the seed-42 ON and OFF runs |
| [M6 Evaluation and docs](#m6-evaluation-and-docs-jan-410) | Jan 4–10 | Results table filled from held-out seeds. A clean clone runs the OFF demo in under 5 minutes. A fast run finishes in under 10 minutes. |
| [M7 Ship](#m7-ship-jan-1117) | Jan 11–17 | Submitted on HackerEarth |

### M0 Foundations (Nov 22–29)

| Task | Who | Req |
| --- | --- | --- |
| ✅ Event schema and seeded generator | | D1–D3 |
| ✅ Generator v2: low-and-slow s1/s5, decoys, account profiles, chain labels, traveler fixture, size cap | | D3.1–D3.4, D6 |
| Register on HackerEarth (name, email, company, LinkedIn, GitHub) | You | Submission |
| Sign up for Meko Cloud (Free), create an API key under **Settings > API Keys**, put it in `.env` as `MEKO_API_KEY=` | You | K9 |
| Create an empty public GitHub repo; then the existing history gets pushed to it | You | Submission |
| Ask on the Meko Discord: is AMP Postgres on the Free plan, when does the monthly quota reset, and are hackathon credits available? | You | K5, K8 |
| Meko client in `packages/engine/src/meko/`: MCP (memory, knowledge base, conversations) and REST (datapacks, uploads, artifacts, promotion) | | K9 |
| Create the `signals` and `patterns` datapacks | | §7 |
| Spike script that answers K1–K11; results written to `docs/spikes.md` | | K1–K11 |
| Update `design.md` with the answers | | |

### M1 Data and agents, OFF mode (Nov 30–Dec 6)

| Task | Req |
| --- | --- |
| Postgres store (AMP or PGlite): events table, device↔account and payee↔account views. The runner inserts each event as it replays. | D4 |
| Knowledge docs in `knowledge/`: fraud playbooks (one per attack type), `risk-rules.md`, `step-up-policy.md`; upload script | A5, C2 |
| Runner: fast mode, `--meko off`, run record, quota guard | R1, R4, R6, R7 |
| All four detection agents in OFF mode, reading the account profiles, with tests | A1–A5, D6 |

Exit check: `npm run replay -- --seed 42 --meko off` writes signals and a `runs/<id>.json` file. A test shows that an agent query can't see an event that hasn't been replayed yet.

### M2 Thin live slice (Dec 7–13)

| Task | Req |
| --- | --- |
| ON mode: signals written with `memory_add` and recalled with `memory_search`, filtered by entity and the 72-hour window. The runner waits until a new signal is retrievable; run reset. | A5–A7, R5 |
| Decision agent: triggers, noisy-OR risk, policy, quoted playbook and policy passages, decision record with every retrieval | C1–C3 |
| Stops and step-ups: attacker locked out after a stop; OTP outcomes from the world simulator | R2, R3 |
| Traces: one Meko conversation per case, a turn per flagged decision, searches carrying the case `conversation_id`; daily allow ledger | C4, C5 |
| Memory hygiene: fact-free user turns, ID-based trust, end-of-run audit | R8 |
| `metrics.ts`: prevented and caught-early per chain, from what the runner executed | §8 |
| Dry run first: `--meko dry` reports the conversation calls and searches a run needs, checked against the ceiling | R7, §9 |
| Two live ON runs on seed 42 | |

### M3 Memory pays off (Dec 14–20)

| Task | Req |
| --- | --- |
| Analyst agent: case closes → indicators → candidate pattern and incident report, both saved as artifacts, with a version-hash list per case | L1, L2 |
| Approval: HTTP endpoint, plus simulated approval for batch runs. On approval: approval conversation, `memory_add` linked to it, promote, confirm in the promoted list. | L3, L4 |
| Agents recall approved patterns on the indicators visible at each event, and add `pattern_match` signals | A6 |
| Pattern reset between evaluation runs, with a probe search before each run | R5 |
| Tune thresholds, on seed 42 only. Four live ON runs. | §8 |

### M4 Dashboard I (Dec 21–27)

Holiday week, so the scope stays small.

| Task | Req |
| --- | --- |
| `packages/dashboard` (React + Vite); Hono server with SSE in the engine package | U1–U3 |
| Paced replay mode | R1 |
| Live feed with risk colors and text labels | U1 |
| Account timeline | U2 |
| Alert view: decision, why, signals by agent, patterns, rules with the playbook quote, link to the Meko trace | U3 |

### M5 Dashboard II (Dec 28–Jan 3)

Holiday week again, and the end of December's quota, so no live evaluation runs.

| Task | Req |
| --- | --- |
| Approval queue and patterns library, with reuse counts | U4 |
| Metrics page: ON vs OFF, per chain | U5 |
| Replay from recorded runs | U6 |

### M6 Evaluation and docs (Jan 4–10)

| Task | Req |
| --- | --- |
| Evaluation after the quota reset: seeds 101–105, one OFF and one ON run each, plus one stability re-run of an ON seed from the same starting state | D5, R5 |
| Could: one "ON without learnings" run, to separate shared signals from learned patterns | §8 |
| Results table (prevented, caught early, per chain) and method in the README | DOC1, DOC3 |
| `docs/walkthroughs.md`: s2 stopped at the reset, s5 pattern reuse, s6 STEP-UP then ALLOW, a routine ALLOW from the ledger | DOC2 |
| UI polish and an accessibility pass | §9 |
| Setup tested from a clean clone; time a fast run; add an open-source licence (MIT unless you prefer another) | §9, Submission |
| Static demo (dashboard plus recorded runs, no keys) on GitHub Pages | U7 |
| If time allows: case notes, self-learning panel, Ollama explanations | L5, U8, U9 |

### M7 Ship (Jan 11–17)

| Task | Who | Req |
| --- | --- | --- |
| Write the video script, record, edit (under 5 minutes) | You + me | DOC4 |
| Final checks: links, setup steps, licence, demo link | | Submission |
| Submit on HackerEarth by Jan 15 | You | Submission |
| Optional: share the demo link for People's choice votes | You | |

## Week-1 checks

Every check runs from one spike script against the real Meko account. The answers go into `docs/spikes.md`.

| ID | Question | How to check | If it fails |
| --- | --- | --- | --- |
| K1 | Is a signal retrieved, by its expected ID, when another agent handles a linked event on another account, and how fast? | Agent A writes a signal about device D on account 1. Agent B searches while handling account 2 on device D. Poll until the expected ID comes back or 30 s pass. | Pace the replay to the measured delay; record timeouts |
| K2 | Can we start each run clean? | Write test signals under 4 agent IDs, call `memory_delete_all` per agent, search again. Also try a `run_id` filter on search. | Clear the datapack by hand between runs |
| K3 | Which search returns promoted patterns best? | Add and promote a test pattern, then query it with `knowledgebase_search` and with `memory_search` | Use whichever finds it; `patterns` holds only approved patterns either way |
| K4 | What does promotion need, and how do we confirm it? | Create a conversation in `patterns`, `memory_add` linked to it, promote at once and again later, then promote the same ID twice. Check the promoted list each time. | Bounded retries; confirm via the promoted list; treat a repeat as done |
| K5 | Is AMP Postgres available on the Free plan? | Ask the agent to create one; check the endpoint and the budget | PGlite locally, same SQL |
| K6 | What does Meko extract from a trace turn, under which agent ID, and how long does it take? | Save a turn whose user turn is fact-free, with the details in output and reasoning. List every memory page over a few minutes. | The audit deletes anything not written by the runner (R8) |
| K7 | Can promoted patterns be deleted between evaluation runs? | Try `memory_delete_by_id` on a promoted memory, then try in the portal | A fresh `patterns` datapack per evaluation run (up to 6) |
| K8 | How fast do runs use up the quota, and when does it reset? | Count calls during K1–K7; ask on Discord | Develop in OFF mode; evaluate after the reset; ask for credits |
| K9 | Does Node connect with our headers? | Connect with the MCP SDK and list tools; send one REST call | Use REST wherever an endpoint exists |
| K10 | How large can one conversation message be? | Save a ledger turn of about 150 lines | Split the ledger by half-day |
| K11 | Do searches tagged with a `conversation_id` show up in that conversation's trace, including searches in `patterns`? | Run one search in each datapack with a case's `conversation_id`, then open the trace in the portal | The decision record lists every search either way |

## Meko quota budget

| Resource | Free limit | Per ON run | Notes |
| --- | --- | --- | --- |
| Conversation calls | 1,000 / month | 120 ceiling | STEP-UP and BLOCK traces, case files, allow ledger (14), approvals. Measured by the M2 dry run before the first ON run. |
| Searches | 10,000 / month | ≤ 800 | Agent recall, plus a signal check on each decision trigger (275 on seed 42). Measured by the M2 dry run. |
| Datapacks | 10 ever | 2 working, up to 6 for evaluation | Deleting one doesn't free its slot |
| Knowledge storage | 100 MB | < 1 MB | A handful of markdown files |

All development runs use OFF mode, which makes no Meko calls. ON runs are kept for integration checks and evaluation:

| Month | ON runs | Conversation calls (ceiling) |
| --- | --- | --- |
| December | M2: 2, M3: 4 | 720 |
| January | M6 evaluation: 6, ablation: 1 (Could), demo footage: 1 | 960 (about 800 expected) |

January is tight. The quota guard refuses a run that would go over. If the quota runs short, drop the ablation first, then record the video from recorded runs.

## Cut list

If a milestone slips, drop in this order:
1. Could items (U9, the ablation run, Ollama explanations)
2. Replay (U6)
3. Public static demo (U7). Record the video from a local run instead.
4. Case notes (L5, U8)
5. Patterns library beyond the bare approval queue (U4)

Never cut any of these. They are what the judges score:
- the OFF baseline
- the learning loop (L1–L4)
- traces and the allow ledger (C3–C5)
- memory hygiene (R8)
- the results table
- the video

## Demo video script (under 5 minutes)

| Time | Scene |
| --- | --- |
| 0:00–0:20 | **Problem:** a takeover happens in small steps, and each step is seen by a different system |
| 0:20–0:50 | **Setup:** four agents and one shared memory in Meko; the two datapacks in the portal |
| 0:50–2:20 | **Live catch (s2):** support call with a weak check → reset. The step-up goes to the real owner's phone, so the caller can't pass, and the ₹1,80,000 transfer never happens. Signals light up across agents. |
| 2:20–3:05 | **Why:** open the alert, walk through the reason and the playbook passage, jump to the Meko trace |
| 3:05–3:50 | **Memory pays off:** approve the s1 pattern; a week later s5 is stopped at the login, citing it |
| 3:50–4:30 | **Numbers:** Meko ON vs OFF on held-out seeds: prevented, caught early |
| 4:30–4:40 | **Close:** repo and demo links |

## Submission checklist

- [ ] Demo video under 5 minutes (link)
- [ ] Public GitHub repo with an open-source licence
- [ ] README: setup instructions, architecture, how Meko is used, results table (prevented and caught early, per chain)
- [ ] Docs: PRD, design, methodology, at least 4 trace walkthroughs
- [ ] Public demo link (Should)
- [ ] Submitted on HackerEarth before Jan 15

## Working rhythm

- Each milestone ends with a commit and an updated status list in the README.
- Check scope against this plan every Sunday. Move anything late down the cut list instead of stretching the milestone.
