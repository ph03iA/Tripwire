# Results

Definitions are in the [PRD](prd.md#8-evaluation). Seed 42 is the development seed: rules and thresholds are tuned on it. The held-out results (seeds 101–105) come in M6 and go in the README.

## Seed 42, M2 (2026-11-26)

Three runs of the same stream:
- **OFF:** no Meko. Each decision sees only the signals of the agent that owns the event.
- **ON, dry:** the full ON pipeline against the in-process stand-in for Meko, whose search is ideal (every matching signal comes back).
- **ON, live:** the first run against Meko itself, run `42-on-2026-11-26T15-40-33-011Z`.

The OFF and dry columns come from the code after the review fixes (#9–#12). The live run used the code before them, so its chains and call counts stand as measured. Its rates are recomputed from its record with the corrected definitions. The second live run (`42-on-2026-11-26T17-17-27-003Z`), on the fixed code, gave the same result on every count.
- **Same results:** every chain was stopped at the same phase, legit BLOCKs and STEP-UPs matched, and so did the calls by tool (311 memory searches).
- **Recall:** 53 of 109 (0.49).
- **Trace writes:** every one came back with a valid receipt. No `conversation_get` look-up was needed, so the receipt check matches what Meko answers.
- **Quotes:** none is missing. The `risk-rules.md` playbook quote of the first run is now a `credential-stuffing.md` passage.
- **Audit:** it passed, keeping the 149 signals and deleting 0 other memories.

So on this seed, ON mode's live results are stable across runs.

| | OFF | ON, dry | ON, live |
| --- | --- | --- | --- |
| Attack chains prevented (of 9) | 4 | 8 | 8 |
| Caught at least one phase early | 1 | 6 | 6 |
| Average phases early, over prevented chains | 0.25 | 0.88 | 0.88 |
| Loss prevented (of ₹4,72,956) | ₹4,17,399 | ₹4,63,570 | ₹4,63,570 |
| BLOCKs on legit sensitive events (of 259) | 0 (0.0%) | 2 (0.8%) | 0 (0.0%) |
| STEP-UPs on legit sensitive events (of 259) | 12 (4.6%) | 30 (11.6%) | 17 (6.6%) |
| BLOCKs and STEP-UPs on all legit events | 0 and 15 | 3 and 31 | 0 and 20 |
| Legit events refused after a stop | 0 | 6 | 0 |
| The s6 traveler | STEP-UP, passed | STEP-UP, passed | STEP-UP, passed |

Where each chain was stopped. This is the phase number: lower is earlier, and "–" means the money left.

| Chain | Takeover phase | OFF | ON, dry | ON, live |
| --- | --- | --- | --- | --- |
| s1 credential stuffing | 4 | 4 | 3 | 3 |
| s2 support-desk reset | 4 | 3 | 2 | 2 |
| s3 card testing | 2 | 2 | 2 | 2 |
| s4-1 fraud ring | 2 | – | – | – |
| s4-2 | 2 | – | 2 | 2 |
| s4-3, s4-4, s4-5 | 2 | – | 1 | 1 |
| s5 repeat attacker | 4 | 4 | 3 | 3 |

s5 has no learned pattern yet, so it's stopped where s1 is. Stopping it at the login with the approved s1 pattern is M3.

## What Meko's memory did in the live run

Meko's search found about half of what an ideal search would.
- **Recall:** the 268 decision searches should have found 107 earlier signals between them. Meko returned 52 of them (0.49).
- **Noise:** each search returned up to 20 results, and on average 0.39 of them were relevant. The rest named other accounts and devices.
- **Timeouts:** 18 searches still missed a signal written in the last 30 s after the two repeats (A7).

It still changed the outcome. Here is how each ON-mode stop happened:
- **s1 and s5, at the email change, a phase earlier than OFF.** The login's new-device signal reached the email change through Meko. The support agent recalled it and its after-recall rule fired (`support.change-after-new-device`, 0.6). The decision used both signals, STEP-UP at 0.76, and the step-up failed.
- **s2, at the reset.** The device agent's two signals on the reset itself, `device.new-after-reset` and `device.new-device`, give 0.76. In ON mode the decision sees every agent's signals, while in OFF mode only the login agent's. The support call's signals from ten minutes earlier weren't among the search's 20 results. With them, the dry run gets 0.93, a BLOCK.
- **s4-2, at the transfer:** the device agent's `device.shared` on the transfer itself. **s4-3 to s4-5:** their logins were refused, because the stop at s4-2 locked the ring's device (R2).

So on this seed, two of ON's gains come from recalled memory (s1 and s5). The rest come from the decision agent seeing every agent's signals on an event.

The live run's misses also explain its 0 legit BLOCKs, where the dry run had 3, 2 of them on sensitive events. Ideal search links three planted look-alikes, two support-desk resets after a KBA call and an email change after a new-device login, into risk of 0.8 or more. Thresholds and retrieval are tuned in M3. The PRD's target is at most 0.5% BLOCKs on legit sensitive events on the held-out seeds, and the dry run is at 0.8%.

## Traces

- Every STEP-UP and BLOCK, 25 in the live run, has its own turn in its account's case conversation. Each holds the decision record, its reasoning and its plan. Each quotes a playbook passage and a step-up policy passage, by document.
- Every other event is a line in the day's allow ledger: unreviewed ALLOWs, reviewed ALLOWs with their risk, and the 10 events refused after a stop. That's 14 turns, one per day.

Quotes by document:

| Document | Quotes |
| --- | --- |
| `step-up-policy.md` | 25 |
| `credential-stuffing.md` | 14 |
| `fraud-ring.md` | 6 |
| `support-desk-takeover.md` | 3 |
| `risk-rules.md` | 1 |
| `travel.md` | 1 |

The `risk-rules.md` quote is wrong. It's the STEP-UP on `evt_000369`, whose playbook passage came from the risk rules. The fixed code accepts a playbook passage only from a playbook. When none is returned, it lists the gap in the decision's `missingQuotes`.

For the s2 walkthrough (DOC2):
- **s2's case conversation:** `23d635fd45dd626bd9786235936c6ffa`. Its trace in `tripwire-signals` holds the memory searches and the STEP-UP turn. Its two knowledge-base searches show under the same ID in `tripwire-patterns`' Observe (K11).
- **The run conversation:** `f72c153a0afbbabc399e2623a490b975`.
- **The ledger:** `4f7122a7f3a906f101bd5983f93e3037`.

## Hygiene (R8)

- The audit kept the run's 149 signals and deleted 0 other memories. Meko mined nothing from the 39 turns, whose user input is a fixed line with no facts in it. K6's turn, which named an event, left a memory.
- A read of `tripwire-signals` after the run found exactly the 149 signals, every one written by the run.
- Since the review fixes, the audit also runs after a failed run, and it fails when its listing misses any of the run's own signals. Only one live ON run at a time can use the datapack.

## Cost and speed

The dry run's estimate held, apart from the A7 repeat searches. Fewer flagged decisions meant fewer quotes and turns.

| Calls | ON, dry | ON, live |
| --- | --- | --- |
| `memory_search` | 273 | 311 |
| `knowledgebase_search` | 78 | 50 |
| `conversation_add_message` | 53 | 39 |
| `memory_add` | 148 | 149 |
| `conversation_create` (not counted in the quota) | 119 | 119 |

- **Duration:** the live run took 10.6 minutes.
- **Decision latency:** p50 1.1 s and p95 8.3 s, searches included. The p95 is the A7 repeats.
- **Quota this month:** with the week-1 checks, 328 of 1,000 memory searches, 61 of 1,000 KB searches and 44 of 1,000 conversation messages are used.

## For M3

- **Retrieval recall:** raise it from 0.49. Signals all read alike, and `memory_search` has no metadata filter.
  - phrase each signal around its account and entities;
  - search per entity;
  - or recall signals by listing the run's memories with `memory_get_all`, which isn't a counted search.
- **Look-alikes:** tune thresholds on seed 42 so that ideal retrieval doesn't block them.
- **Locks on known devices:** a stop on an event from a device in the profile locks the owner's own device.
