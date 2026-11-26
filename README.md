# Tripwire

Account-takeover detection for a payments app, where every agent remembers what the others saw. ContextCon 2026 entry, Theme 3 "Remember the Attacker", built on [Meko](https://mekodata.ai/).

## The problem
A takeover happens in small steps: a burst of failed logins, a new device, an email change, a payout. Each step is seen by a different system, and none of them looks bad on its own. By the time someone connects them, the money is gone.

## How it works
Four detection agents (login, device, transaction, support) write **risk signals** to shared Meko memory and read each other's. A decision agent turns them into **ALLOW / STEP-UP / BLOCK**, and every decision is saved with its reasoning as a Meko decision trace. When an analyst approves a confirmed attack pattern, it is promoted to a Meko learning, so the next attacker using the same tactics is caught earlier.

Decisions are deterministic (rules + shared memory + approved patterns), so Tripwire runs on Meko's Free plan with no paid APIs and every result is reproducible.

| Doc | What's in it |
| --- | --- |
| [PRD](docs/prd.md) | Problem, goals, requirements, how Meko is used, evaluation |
| [Build plan](docs/plan.md) | Milestones to Jan 15, week-1 checks, quota budget, video script |
| [Engineering spec](docs/engineering-spec.md) | Module map, contracts, rules, testing, CI, PR workflow |
| [Technical design](docs/design.md) | Layout, agents, event schema, scenarios |
| [Meko API notes](docs/meko-api.md) | How Meko is called from TypeScript, Free-plan limits |
| [Week-1 checks](docs/spikes.md) | What the live Meko API does: answers to K1–K11 |
| [Results](docs/results.md) | Seed 42 so far: Meko ON vs OFF, live and dry, with what Meko's memory did |

## Synthetic data
```bash
npm install
npm run generate          # writes data/events.jsonl, labels.json and accounts.json (seed 42)
npm run generate -- --seed 7 --out data/seed7
npm test
```
At most 2,000 events over 14 days from 150 accounts, plus `accounts.json`: what the app knows about each customer before the stream starts. Six attack and trap scenarios are planted in normal traffic: credential stuffing, a support-desk reset, card testing, a fraud ring, a repeat attacker, and an innocent traveler. Benign look-alikes (decoys) make sure no single field value gives an attack away. Ground truth is in `labels.json`, never in the events the agents see.

## Run the agents
```bash
npm run replay -- --seed 42 --meko off   # the four agents and the decision agent over the stream → runs/<run id>.json,
                                         # then where each attack chain was stopped
npm run knowledge                        # regenerates knowledge/risk-rules.md after a rule changes
npm run upload-knowledge                 # uploads knowledge/ into the tripwire-patterns datapack; needs MEKO_API_KEY
npm run replay -- --seed 42 --meko dry   # the ON pipeline against an in-process stand-in: the Meko calls a live run needs
npm run replay -- --seed 42 --meko on    # shared signals, traces and the allow ledger in your Meko account; spends quota
```
OFF mode needs no account and makes no network calls. ON mode needs `MEKO_API_KEY` in `.env`, the `tripwire-signals` and `tripwire-patterns` datapacks, and the knowledge docs uploaded. It runs the dry pass first and refuses to start if the run could break the per-run ceiling or go over this month's Meko quota. Only one ON run at a time can use the signals datapack. A run on seed 42 makes about 700 Meko calls, at about a second each. The upload sends only files whose bytes changed, and spends no search quota.

## Check Meko
```bash
npm run spike -- k9      # needs MEKO_API_KEY in .env; one week-1 check per argument, k1 … k11
```
The checks run against your real Meko account and spend real quota. They write only to their own `tripwire-spike` datapack, which must already exist (K11 also searches `tripwire-patterns`). Run one only to re-check an answer in [docs/spikes.md](docs/spikes.md).

## Results: Meko ON vs OFF
Held-out seeds 101–105; definitions in the [PRD](docs/prd.md#8-evaluation).

| Metric | Meko OFF | Meko ON |
| --- | --- | --- |
| Attack chains prevented: money never left (of 9) | – | – |
| Caught at least one step early (of 9) | – | – |
| Avg steps early | – | – |
| Loss prevented (₹) | – | – |
| False-positive BLOCKs | – | – |
| STEP-UP friction on legit events | – | – |
| Decision latency p50 / p95 | – | – |
| Meko calls per decision | – | – |

Where each attack chain was stopped (phase number; lower is earlier; "–" means the money left):

| Chain | Takeover phase | Meko OFF | Meko ON |
| --- | --- | --- | --- |
| s1 credential stuffing | 4 | – | – |
| s2 support-desk reset | 4 | – | – |
| s3 card testing | 2 | – | – |
| s4-1 … s4-5 fraud ring | 2 each | – | – |
| s5 repeat attacker | 4 | – | – |

## Status
Milestones are in the [build plan](docs/plan.md).
- [x] PRD and build plan
- [x] Event schema and seeded generator with all 6 scenarios
- [x] Generator v2: low-and-slow s1/s5, decoys, account profiles, chain labels
- [x] M0: Meko account, `signals` / `patterns` datapacks, week-1 checks (the quota's reset day is still unknown)
- [x] M1: Postgres store, knowledge docs and their upload, runner, all four detection agents (OFF mode)
- [ ] M2: live slice: shared signals, decision agent, traces; s2 stopped in Meko. Built; the first live run stopped s2 at the reset ([results](docs/results.md)).
- [ ] M3: analyst agent, approvals → learnings, repeat attacker stopped earlier
- [ ] M4–M5: dashboard
- [ ] M6: held-out evaluation, walkthroughs, docs
- [ ] M7: demo video, submit
