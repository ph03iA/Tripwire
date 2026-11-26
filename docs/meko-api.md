# Meko from TypeScript: what the docs say

Read from docs.mekodata.ai on 2026-11-22. Pages: Datapack API, MCP Server reference, Memory, Learnings, Observability, Trace and resume, AMP. Checked against the live API on 2026-11-23: see [what the API actually does](#what-the-live-api-does) and [spikes](spikes.md).

## Two ways in, and they do different jobs

| Need | Channel | Calls |
| --- | --- | --- |
| Write/read risk signals | **MCP** | `memory_add`, `memory_search`, `memory_update`, `memory_get_all` |
| Search across memory + KB + conversations | **MCP** | `context_search` (results in separate `memory` / `knowledge_base` / `conversation` buckets, plus `match_quality` and `agent_hint`) |
| Search playbooks, rules and approved patterns | **MCP** | `knowledgebase_search` (hybrid semantic + keyword). It is the only search that finds promoted patterns (K3). |
| Decision traces | **MCP** | `conversation_create`, `conversation_add_message` (with `reasoning` and `plan`). `track_token_usage` exists for LLM spend, but Tripwire makes no LLM calls. |
| Create datapacks | REST | `POST /datapacks`. MCP's `datapack_create` also needs a conversation, which needs a datapack (K9). |
| Upload playbooks to the knowledge base | REST | `POST /datapacks/{id}/knowledge-bases/upload-url` with the file's SHA-256, then a multipart POST to storage (without the Meko key: the REST client sends it only to the API), then poll `document-status`. Bytes already stored answer `already_uploaded: true`, so `npm run upload-knowledge` re-sends only changed files, deleting a changed file's older document first. |
| Incident reports and pattern drafts | REST | `POST /datapacks/{id}/artifacts`, `GET /datapacks/{id}/artifacts/{content_hash}` |
| Analyst approval → learning | MCP | `memory_add` linked to an approval conversation, then `memory_promote`. REST `POST /promote-memories` does the same. |

The REST API has **no** memory-add, memory-search or knowledge-search endpoints. Those exist only over MCP.

- MCP URL: `https://mcp.mekodata.ai/mcp`. From TS: `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`, calling `client.callTool({ name, arguments })`. The SDK drops a 429's headers, so the client reads `Retry-After` in its own `fetch` wrapper first.
- REST base: `https://api.mekodata.ai/api/v1`. OpenAPI 3.1 at `https://api.mekodata.ai/openapi.json`.
- Auth on both: `Authorization: Bearer mko_tkn_…` (from **Settings > API Keys**) **and** a `User-Agent` header. Without a User-Agent the WAF returns 403.
- REST responses: `{ data, error }`, and `data` is `null` on error.

## Facts that shape the design

1. **Memory belongs to the user, not the agent.** `memory_search` returns every memory the API key's user wrote in that datapack. `agent_id` is only for trace attribution; it doesn't filter. All four agents share one key, so their signals are shared without extra work. That is sharing within one account across agent namespaces. Meko's Collective Memory is the promoted layer, which in Tripwire holds only approved patterns.
   → The **Meko OFF baseline makes no Meko calls at all**: each agent keeps its own signals in process. That avoids needing per-agent isolation inside Meko. Each ON run writes its signals with its own run conversation as `conversation_id`. `run_id` set to that conversation then scopes `memory_search` and `memory_delete_all` to that run (K2).
2. **Promotion is the learnings flow.** `POST /promote-memories` moves private memories into the datapack's Collective Memory. It can't be undone, and only the owner or a maintainer may call it. An ID comes back in `not_found_ids` when the memory has no embedding yet, has no conversation, was marked private, or was already promoted, so that list alone can't tell failure from success. A promotion is recorded in the trace.
   → One user owns every memory, so anything saved with `memory_add` can be returned by search as soon as it's indexed. Candidate patterns are therefore drafted as artifacts. A pattern becomes a memory only on approval: create an approval conversation, `memory_add` linked to it, promote, then confirm the ID in the promoted list (`memory_get_all` with `promoted=true`). This also follows the challenge rule that only risk signals and confirmed patterns are saved as memories.
3. **There is no traces read API.** Traces are Langfuse spans that Meko records from MCP calls. Agents get "decision traces" by passing `reasoning` to `conversation_add_message`. The portal shows them under **Conversations > Decision trace** and **Observe**, with deep links `?project=<langfuse_project_id>&session=<conversation_id>`.
   → The dashboard's "why" view is built from our own decision record (the same text we send Meko), plus a link into the portal trace.
4. **Postgres in the datapack = AMP.** You create it through MCP (AMP tools are on in Meko Cloud). Reaching it from your own machine needs a public endpoint with an IP allow list (/24 or narrower). On the Free plan, `amp_core_budget` allows 0.5 vCPU (K5).
5. **`memory_add` doesn't dedupe.** Use `memory_update` to change a stored fact.
6. **Listing and bulk deletes are paged.** `memory_get_all` returns one page at a time, and `memory_delete_all` can return `complete: false`. Extraction from conversation turns runs in the background. So the hygiene audit (PRD R8) waits for extraction, pages through everything, and repeats deletes until they report complete.

## Free-tier limits (these drive the budget)

| Limit | Value |
| --- | --- |
| Conversations (`conversation_add_message`) | 1,000 / month |
| Memory searches (`memory_search`) | 1,000 / month (the Usage page, K8; the docs say 10,000 retrievals) |
| KB searches (`knowledgebase_search`) | 1,000 / month (K8) |
| Memory adds (`memory_add`) | 10,000 / month; Meko's own extraction isn't counted (K8) |
| Datapacks | 10 **created ever** (deleting doesn't free a slot) |
| Knowledge storage | 100 MB, 5 MB per file |
| Artifacts | 5 MB each, expire 30 days after last access |
| REST rate | 60 req/min per key (burst 10, `Retry-After: 60`), 10 req/s per IP (burst 20) |
| AMP compute | 0.5 vCPU (K5) |
| Monthly reset date | Not documented and not on the Usage page; ask on Discord (K8) |

A 2,000-event run can't call Meko for every event. Agents score events locally, and only risk signals, non-trivial decisions and patterns reach Meko. Each run is also recorded to `runs/*.json`, so dashboard replays and metrics don't spend quota.

## What the live API does

Found by the [week-1 checks](spikes.md) on 2026-11-23, beyond what the docs say:

- **`datapack_create` and the `amp_*` tools need a `conversation_id`**, although their schemas mark it optional: they answer `conversation_id_required`. `conversation_create` works without one. Every other tool was always called with one, so whether it needs it is unknown (K9).
- **Tools answer with a JSON string.** `structuredContent` only wraps the same string as `{ result }`. Some failures arrive inside a normal answer as `{"error": …}`.
- **`memory_add` stores the text verbatim** and returns it with its ID (`results[0].id`). K1 found one on the first search, 1.1 s after the call returned. That is one sample, so it sets no upper bound. Metadata comes back on search.
- **`memory_search` drops rows under a raw similarity of 0.2** but returns unrelated rows above it, so callers must check the entity themselves.
- **`context_search`'s `knowledge_base` bucket doesn't include promoted patterns.** `knowledgebase_search` returns them, with `metadata_filters.source: "memory"` and the approval conversation's ID as `document_id` (K3).
- **Promoted memories leave the private store and can't be deleted through the API.** `memory_delete_by_id` answers `memory_is_promoted`, and they aren't knowledge-base files. An owner can delete one on the datapack's Collective Memory page in the portal (K7).
- **A search shows in the trace of the datapack it ran in.** Searches tagged with a case's `conversation_id` appear in Observe under a trace with that ID, but each in its own datapack's view (K11).
- **A 32-hex `session_id` becomes the conversation ID unchanged**, and `conversation_get` on an unknown ID answers `not_found` (K10).
- **Traces include Meko's own LLM work.** Each `conversation_add_message` trace shows the memory extraction's OpenAI spans and an estimated cost. Tripwire makes none of those calls.
- **Conversation turns are mined for memories.** Within about 30 s, Meko saves one memory from a turn's user input, under the conversation's agent ID and tagged with the conversation. Nothing came from `output` or `reasoning` (K6).
- **Conversation writes dedupe.** The same `seed` returns the same message ID and stores one message, and the same `session_id` returns the same conversation (K10). A 13 KB turn is stored whole. Each call can still be mined for a memory of its own, so a retry can leave an extra one (K6, K10).
- **Some answers carry the account owner's name and email** (`memory_get_all` rows, `GET /datapacks`), so raw answers are never logged.
