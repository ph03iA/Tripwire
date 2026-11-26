# Week-1 checks: what Meko actually does

These are the answers to K1–K11 from the [build plan](plan.md#week-1-checks). They were run on 2026-11-23 against the Free plan with `npm run spike -- <check…>` (`packages/engine/src/meko/spike.ts`), corrected on 2026-11-24 after a review, and completed on 2026-11-26 with the portal checks.

Every check writes only to a disposable `tripwire-spike` datapack, which the script finds by name and never creates. The raw answers stay in `runs/spike/` on the machine that ran them (git-ignored), with the account owner's name and email removed. Answers from any other datapack aren't saved.

## Answers

| ID | Question | Answer | What it changes |
| --- | --- | --- | --- |
| K1 | Is a signal found, by its ID, when another agent searches a linked entity, and how fast? | **Yes, on the first search.** The device agent's `memory_add` returned the stored memory with its ID. The login agent's search for the device, started right after the write returned, found it on the first poll, 1.1 s later. That is one sample, so it sets no upper bound on indexing time. The text is stored verbatim and the metadata comes back on search. | A7 held in the one run measured. The runner keeps A7's bounded wait and records a timeout as an outcome. |
| K2 | Can each run start clean? | **Yes, two ways.** `memory_search` with `run_id` set to a conversation ID returns only memories written with that `conversation_id`: run B found 4 of 4, run A 1 of 1, and the unscoped search found 5. `memory_delete_all` with `agent_id` and `run_id` deleted exactly 1 memory per agent (`complete: true`), and run A's signal stayed. | Each ON run gets a run conversation. Signals are written with it and recalled with `run_id` set to it, so runs never see each other's signals. |
| K3 | Which search returns promoted patterns? | **`knowledgebase_search`, at once (2.1 s).** `memory_search` doesn't, because promotion moves the memory out of the private store. `context_search` doesn't either: its `knowledge_base` bucket stayed empty for 50 s. The hit has `metadata_filters.source: "memory"`, the promoted memory's ID, and the approval conversation's ID as its `document_id`. | Patterns are searched with `knowledgebase_search`. `source: "memory"` separates a learned pattern from a playbook passage. |
| K4 | What does promotion need, and how is it confirmed? | **Only a link to a conversation.** Promoting straight after `memory_add` worked: `inserted_ids` held the ID, and the promoted list (`memory_get_all` with `promoted: true`) showed it at once. A second promote returned the ID in `not_found_ids` and changed nothing. Afterwards `memory_get_by_id` answers `not_found`. MCP's `memory_promote` does the same job as REST `POST /promote-memories`. | Promote once and confirm in the promoted list. After an unknown outcome, check the list before promoting again. |
| K5 | Is AMP Postgres on the Free plan? | **Yes, capped at 0.5 vCPU.** `amp_core_budget`: tier `free`, `max_cores` 0.5, none used, no clusters. Nothing was created: that's your call. | Recommendation: keep PGlite. OFF mode must make no Meko calls, every history query would cross the network (thousands per run), and reaching AMP from a laptop needs a public endpoint with an IP allow list. |
| K6 | What does Meko extract from a trace turn, under which agent ID, and how fast? | **One memory per turn, from the user turn, within 30 s.** Input "Decision requested for event evt_k6a." became "On November 23, 2026, User requested that a decision be made regarding event ID 'evt_k6a'…". It was saved under the conversation's agent ID (`tripwire:decision`) and tagged with the case conversation. Nothing came from `output`, `reasoning` or `plan` in 5 minutes. The K10 ledger turn, sent twice with one seed, left 2 such memories, so extraction may run once per call. | Trace and ledger turns do create memories, so the R8 audit is needed. Recall is unaffected, because it filters by the run conversation. The end-of-run audit deletes every `tripwire:decision` memory: that agent writes turns but never writes memories itself. |
| K7 | Can promoted patterns be deleted? | **Not through the API, but yes in the portal.** `memory_delete_by_id` answers `memory_is_promoted`. `knowledgebase_delete_document` with the pattern's `document_id` answers `NOT_FOUND`, and the pattern isn't in the REST file list. On 2026-11-26 the owner deleted it on the datapack's **Collective Memory** page, and a `knowledgebase_search` afterwards found nothing. | Each evaluation run still gets a fresh patterns datapack (R5), because the reset can't be scripted. Clearing a datapack by hand in the portal is the fallback if the slots run short. The API call behind the portal's Delete button is unknown. |
| K8 | How fast do runs use the quota, and when does it reset? | **Meko counts exactly what the client sends, but the Free search caps are 1,000 memory searches and 1,000 KB searches a month, not 10,000 retrievals.** The portal's Usage page on 2026-11-26 matched the spike's attempts log: 17 of 1,000 memory searches, 10 of 1,000 KB searches, 5 of 1,000 conversation messages, 7 of 10,000 memory adds, 4 of 10 datapacks. `context_search` isn't on the page. Meko's own memory extraction counts as neither a memory add nor Workbench tokens (0 of 10 M). Each call takes 0.3–2 s (table below), so an ON run is bound by latency: about 800 searches and 120 conversation calls take roughly 15–20 minutes. | An ON run's searches must fit 1,000 memory and 1,000 KB searches a month, so Free fits about one full ON run a month ([budget](plan.md#meko-quota-budget)). The M2 dry run measures each kind. Every spike run appends its attempts to `runs/spike/attempts.jsonl`, and K8 adds them up. The reset date is still unknown. |
| K9 | Does Node connect with our headers? | **Yes.** The MCP SDK lists 57 tools with `Authorization` and `User-Agent`, and REST `GET /datapacks` answers. `datapack_create` and the `amp_*` tools answer `conversation_id_required`, although their schemas mark it optional. `conversation_create` works without one. Every other tool was always called with one, so whether it needs it is unknown. | Every call except `conversation_create` carries a `conversation_id`. A conversation needs a datapack, so datapacks are created over REST (`POST /datapacks`; a repeated name answers 409). Tools answer with a JSON string, and some failures come inside it as `{"error": …}`. The client raises both. |
| K10 | How large can one conversation message be? | **150 lines (13,149 characters) are stored whole.** `conversation_get` shows the turn after about 8 s, because the write runs in the background. The same `seed` sent twice returns the same message ID and stores one message. The same `session_id` given to `conversation_create` twice returns the same conversation. A 32-hex `session_id` comes back unchanged as the conversation ID, and `conversation_get` on an ID that was never created answers `not_found` (checked 2026-11-24). | One allow-ledger turn per day fits (C5). Conversation writes carry a `seed` or `session_id`, so a retry stores nothing new. A retry still has a side effect: each call can be extracted into a memory of its own (K6). A turn whose 3 attempts all fail is looked up before the run carries on ([spec](engineering-spec.md)). |
| K11 | Do searches tagged with a case's `conversation_id` show in its trace, including searches in another datapack? | **Yes, in the trace of the datapack each search ran in.** Re-run on 2026-11-24 with case `a1778ae4…` in `tripwire-spike`. Its trace (portal: Observe) holds `conversation_create`, `memory_search` and `knowledgebase_search` from `tripwire-spike`. The `knowledgebase_search` in `tripwire-patterns` appears only in that datapack's Observe, under a trace with the same ID. The first run, on 2026-11-23, searched the account's default datapack instead, which the spike shouldn't touch. | A case's trace in `tripwire-signals` shows its signal searches and turns. Its pattern and playbook searches show in `tripwire-patterns` under the same case ID. The trace walkthroughs (DOC2) show both views, and the decision record lists every search (C3). |

## Other things learned

- `memory_search` drops rows under a raw similarity of 0.2, but anything above that comes back even when it's unrelated. K3's search for a card-testing pattern returned K1's device signal at 0.32. So the ON store's entity match is required, not optional.
- Some answers carry the account owner's name and email: `memory_get_all` rows and `GET /datapacks`. Raw answers are never logged.
- Datapack names are unique per account (409 on a repeat), and `GET /datapacks?name=…&limit=1` finds one by exact name.
- REST allows 60 requests a minute per key (burst 10, `Retry-After: 60`) and 10 a second per IP.
- `conversation_create` and `memory_get_all` aren't counted in the quota: the spike sent 15 and 19 of them, and the Usage page counted only the 5 `conversation_add_message` calls and the 17 memory searches. So an ON run can open a case conversation for every account it touches.
- The portal's Conversations list shows only conversations that have a message. Observe (Langfuse) shows every trace, and its times are in the viewer's local time zone.
- Each `conversation_add_message` trace includes Meko's own memory extraction: "Create a new memory in Mem0", with OpenAI embedding and generation spans and an estimated cost (2 calls, about 16,000 tokens for the K10 ledger turn sent twice). Tripwire makes no LLM calls, so the README and the trace walkthroughs must say these spans are Meko's.

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

## Datapacks: budget

The brief asks for separate datapacks for raw signals and confirmed patterns ([PRD §1](prd.md#challenge-coverage)), so there are two working datapacks:
- `tripwire-signals`: used by every ON run, in development and evaluation. Each run's signals are kept apart by its run conversation (K2).
- `tripwire-patterns`: playbooks, rules, policy, and the patterns approved during development.

Both were created on 2026-11-24.

Promoted patterns can't be deleted through the API (K7), so each evaluation run gets a fresh patterns datapack. The 5 held-out seeds plus the stability re-run make 6.

The Free plan allows 10 datapacks, ever, and this uses all of them:
- the default one and `tripwire-spike`;
- the 2 working datapacks;
- 6 for evaluation.

4 are used. None is spare, but three things soften that:
- An evaluation run that fails before promoting a pattern leaves its datapack clean. The R5 probe search shows it, so the datapack can be used again.
- A patterns datapack can be cleared by hand on its Collective Memory page and reused (K7).
- Dropping the stability re-run would free one.

## Still open

- The day the monthly quota resets. The Usage page doesn't show it.
- AMP (K5): the recommendation is to keep PGlite.
