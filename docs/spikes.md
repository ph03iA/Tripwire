# Week-1 checks: what Meko actually does

These are the answers to K1–K11 from the [build plan](plan.md#week-1-checks). They were run on 2026-11-23 against the Free plan with `npm run spike -- <check…>` (`packages/engine/src/meko/spike.ts`).

Every check ran in a disposable `tripwire-spike` datapack. The raw answers stay in `runs/spike/` on the machine that ran them (git-ignored), with the account owner's name and email removed.

## Answers

| ID | Question | Answer | What it changes |
| --- | --- | --- | --- |
| K1 | Is a signal found, by its ID, when another agent searches a linked entity, and how fast? | **Yes, at once.** The device agent's `memory_add` returned the stored memory with its ID. The login agent's search for the device, started right after the write returned, found it on the first poll, in 1.1 s. The text is stored verbatim and the metadata comes back on search. | A7 holds without pacing: a signal is searchable as soon as `memory_add` returns. Timeouts are still recorded. |
| K2 | Can each run start clean? | **Yes, two ways.** `memory_search` with `run_id` set to a conversation ID returns only memories written with that `conversation_id`: run B found 4 of 4, run A 1 of 1, and the unscoped search found 5. `memory_delete_all` with `agent_id` and `run_id` deleted exactly 1 memory per agent (`complete: true`), and run A's signal stayed. | Each ON run gets a run conversation. Signals are written with it and recalled with `run_id` set to it, so runs never see each other's signals. |
| K3 | Which search returns promoted patterns? | **`knowledgebase_search`, at once (2.1 s).** `memory_search` doesn't, because promotion moves the memory out of the private store. `context_search` doesn't either: its `knowledge_base` bucket stayed empty for 50 s. The hit has `metadata_filters.source: "memory"`, the promoted memory's ID, and the approval conversation's ID as its `document_id`. | Patterns are searched with `knowledgebase_search`. `source: "memory"` separates a learned pattern from a playbook passage. |
| K4 | What does promotion need, and how is it confirmed? | **Only a link to a conversation.** Promoting straight after `memory_add` worked: `inserted_ids` held the ID, and the promoted list (`memory_get_all` with `promoted: true`) showed it at once. A second promote returned the ID in `not_found_ids` and changed nothing. Afterwards `memory_get_by_id` answers `not_found`. MCP's `memory_promote` does the same job as REST `POST /promote-memories`. | Promote once and confirm in the promoted list. After an unknown outcome, check the list before promoting again. |
| K5 | Is AMP Postgres on the Free plan? | **Yes, capped at 0.5 vCPU.** `amp_core_budget`: tier `free`, `max_cores` 0.5, none used, no clusters. Nothing was created: that's your call. | Recommendation: keep PGlite. OFF mode must make no Meko calls, every history query would cross the network (thousands per run), and reaching AMP from a laptop needs a public endpoint with an IP allow list. |
| K6 | What does Meko extract from a trace turn, under which agent ID, and how fast? | **One memory per turn, from the user turn, within 30 s.** Input "Decision requested for event evt_k6a." became "On November 23, 2026, User requested that a decision be made regarding event ID 'evt_k6a'…". It was saved under the conversation's agent ID (`tripwire:decision`) and tagged with the case conversation. Nothing came from `output`, `reasoning` or `plan` in 5 minutes. The K10 ledger turn, sent twice with one seed, left 2 such memories, so extraction may run once per call. | Trace and ledger turns do create memories, so the R8 audit is needed. Recall is unaffected, because it filters by the run conversation. The end-of-run audit deletes every `tripwire:decision` memory: that agent writes turns but never writes memories itself. |
| K7 | Can promoted patterns be deleted? | **Not through the API.** `memory_delete_by_id` answers `memory_is_promoted`. `knowledgebase_delete_document` with the pattern's `document_id` answers `NOT_FOUND`, and the pattern isn't in the REST file list. It stayed promoted and searchable. | Each evaluation run needs a fresh patterns datapack (R5). Trying in the portal is still open. |
| K8 | How fast do runs use the quota, and when does it reset? | **The spike used about 29 searches and 5 conversation messages** (of 10,000 and 1,000 a month). Each call takes 0.3–2 s (table below), so an ON run is bound by latency: about 800 searches and 120 conversation calls take roughly 15–20 minutes. | The reset date is still open. So is whether reads like `memory_get_all` and `conversation_get` also count. Compare with the portal's usage page. |
| K9 | Does Node connect with our headers? | **Yes.** The MCP SDK lists 57 tools with `Authorization` and `User-Agent`, and REST `GET /datapacks` answers. Every MCP tool needs a `conversation_id`, even where its schema marks it optional (`datapack_create` and the `amp_*` tools answer `conversation_id_required`). | A conversation needs a datapack, so datapacks are created over REST (`POST /datapacks`; a repeated name answers 409). Tools answer with a JSON string, and some failures come inside it as `{"error": …}`. The client raises both. |
| K10 | How large can one conversation message be? | **150 lines (13,149 characters) are stored whole.** `conversation_get` shows the turn after about 8 s, because the write runs in the background. The same `seed` sent twice returns the same message ID and stores one message. The same `session_id` given to `conversation_create` twice returns the same conversation. | One allow-ledger turn per day fits (C5). Conversation writes carry a `seed` or `session_id`, so they are safe to retry, and the "mark the run incomplete" path goes away. |
| K11 | Do searches tagged with a case's `conversation_id` show in its trace, including searches in another datapack? | **The searches ran.** `memory_search` and `knowledgebase_search` ran in `tripwire-spike`, and `memory_search` in another datapack, all tagged with the case's conversation. | Whether they appear in the trace needs a look in the portal: open "tripwire spike: k11 case: check its trace in the portal" in `tripwire-spike`. |

## Other things learned

- `memory_search` drops rows under a raw similarity of 0.2, but anything above that comes back even when it's unrelated. K3's search for a card-testing pattern returned K1's device signal at 0.32. So the ON store's entity match is required, not optional.
- Some answers carry the account owner's name and email: `memory_get_all` rows and `GET /datapacks`. Raw answers are never logged.
- Datapack names are unique per account (409 on a repeat), and `GET /datapacks?name=…&limit=1` finds one by exact name.
- REST allows 60 requests a minute per key (burst 10, `Retry-After: 60`) and 10 a second per IP.

## Latency

Single calls from the development machine to Meko Cloud, as measured by the spike:

| Call | Time |
| --- | --- |
| `memory_add` | 0.5–0.8 s |
| `memory_search` | 0.8–1.3 s (once 6 s) |
| `knowledgebase_search` | 0.6–2.1 s |
| `context_search` | 1.4–3.0 s |
| `conversation_create` | 0.3–1.6 s |
| `conversation_add_message` | 0.5–0.7 s (readable after about 8 s) |
| `memory_get_all`, `memory_delete_all`, `memory_promote` | 0.3–0.4 s |

## Datapacks: proposal

The Free plan allows 10 datapacks, ever. Two are used: the default one and `tripwire-spike`.

With today's layout:
- 2 working datapacks: `tripwire-signals` and `tripwire-patterns`.
- 6 for evaluation, because of K7: one fresh patterns datapack per run.

That makes all 10, with no spare for a re-run.

K2 makes a simpler layout possible: **one datapack per world.** It holds that world's run-scoped signals, case conversations and ledger, plus its playbooks and approved patterns:
- **Dev:** one datapack, `tripwire-dev`.
- **Evaluation:** one fresh datapack per run.

The searches don't get in each other's way:
- Signal recall filters by the run conversation.
- Promoted patterns live outside the private store.
- Extracted memories carry case conversations, which recall never asks for.

K11's cross-datapack question goes away too. This uses 1 + 6 datapacks and leaves 1 spare. It changes the datapack wording in the PRD (R5) and in the design. Until it's decided, no working datapack is created.

## Still open: needs you

1. In the portal:
   - **K11:** the trace of "tripwire spike: k11 case…"
   - **K7:** whether the promoted test pattern ("Approved fraud pattern k4mwthhk3i…", Learnings in `tripwire-spike`) can be deleted there.
   - **K8:** the usage counters, to compare with the counts above.
2. On the Meko Discord: when the monthly quota resets, and whether hackathon credits exist (K8).
3. Decisions:
   - the datapack layout above;
   - AMP (K5): the recommendation is to keep PGlite.
