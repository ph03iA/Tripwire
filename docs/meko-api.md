# Meko from TypeScript: what the docs say

Read from docs.mekodata.ai on 2026-11-22. Pages: Datapack API, MCP Server reference, Memory, Learnings, Observability, Trace and resume, AMP.

## Two ways in, and they do different jobs

| Need | Channel | Calls |
| --- | --- | --- |
| Write/read risk signals | **MCP** | `memory_add`, `memory_search`, `memory_update`, `memory_get_all` |
| Search across memory + KB + conversations | **MCP** | `context_search` (results in separate `memory` / `knowledge_base` / `conversation` buckets, plus `match_quality` and `agent_hint`) |
| Search playbooks and rules | **MCP** | `knowledgebase_search` (hybrid semantic + keyword) |
| Decision traces | **MCP** | `conversation_create`, `conversation_add_message` (with `reasoning` and `plan`). `track_token_usage` exists for LLM spend, but Tripwire makes no LLM calls. |
| Create datapacks | REST | `POST /datapacks` |
| Upload playbooks to the knowledge base | REST | `POST /datapacks/{id}/knowledge-bases/upload-url`, then a multipart POST to storage, then poll `status_url` |
| Incident reports and pattern drafts | REST | `POST /datapacks/{id}/artifacts`, `GET /datapacks/{id}/artifacts/{content_hash}` |
| Analyst approval → learning | MCP + REST | `memory_add` in `patterns` (MCP), then `POST /promote-memories` (REST) |

The REST API has **no** memory-add, memory-search or knowledge-search endpoints. Those exist only over MCP.

- MCP URL: `https://mcp.mekodata.ai/mcp`. From TS: `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`, calling `client.callTool({ name, arguments })`.
- REST base: `https://api.mekodata.ai/api/v1`. OpenAPI 3.1 at `https://api.mekodata.ai/openapi.json`.
- Auth on both: `Authorization: Bearer mko_tkn_…` (from **Settings > API Keys**) **and** a `User-Agent` header. Without a User-Agent the WAF returns 403.
- REST responses: `{ data, error }`, and `data` is `null` on error.

## Facts that shape the design

1. **Memory belongs to the user, not the agent.** `memory_search` returns every memory the API key's user wrote in that datapack. `agent_id` is only for trace attribution; it doesn't filter. All four agents share one key, so their signals are shared without extra work. That is sharing within one account across agent namespaces. Meko's Collective Memory is the promoted layer, which in Tripwire holds only approved patterns.
   → The **Meko OFF baseline makes no Meko calls at all**: each agent keeps its own signals in process. That avoids needing per-agent isolation inside Meko. Between ON runs, `signals` is cleared with `memory_delete_all` per `agent_id` (check K2).
2. **Promotion is the learnings flow.** `POST /promote-memories` moves private memories into the datapack's Collective Memory. It can't be undone, and only the owner or a maintainer may call it. An ID comes back in `not_found_ids` when the memory has no embedding yet, has no conversation, was marked private, or was already promoted, so that list alone can't tell failure from success. A promotion is recorded in the trace.
   → One user owns every memory, so anything saved with `memory_add` can be returned by search as soon as it's indexed. Candidate patterns are therefore drafted as artifacts. A pattern becomes a memory only on approval: create an approval conversation, `memory_add` linked to it, promote, then confirm the ID in the promoted list (`memory_get_all` with `promoted=true`). This also follows the challenge rule that only risk signals and confirmed patterns are saved as memories.
3. **There is no traces read API.** Traces are Langfuse spans that Meko records from MCP calls. Agents get "decision traces" by passing `reasoning` to `conversation_add_message`. The portal shows them under **Conversations > Decision trace** and **Observe**, with deep links `?project=<langfuse_project_id>&session=<conversation_id>`.
   → The dashboard's "why" view is built from our own decision record (the same text we send Meko), plus a link into the portal trace.
4. **Postgres in the datapack = AMP.** You create it through MCP (AMP tools are on in Meko Cloud). Reaching it from your own machine needs a public endpoint with an IP allow list (/24 or narrower). Free-tier compute budget: **not documented, check first.**
5. **`memory_add` doesn't dedupe.** Use `memory_update` to change a stored fact.
6. **Listing and bulk deletes are paged.** `memory_get_all` returns one page at a time, and `memory_delete_all` can return `complete: false`. Extraction from conversation turns runs in the background. So the hygiene audit (PRD R8) waits for extraction, pages through everything, and repeats deletes until they report complete.

## Free-tier limits (these drive the budget)

| Limit | Value |
| --- | --- |
| Conversations (`conversation_add_message`) | 1,000 / month |
| Retrievals (`context_search`, `memory_search`, `knowledgebase_search`) | 10,000 / month |
| Datapacks | 10 **created ever** (deleting doesn't free a slot) |
| Knowledge storage | 100 MB, 5 MB per file |
| Artifacts | 5 MB each, expire 30 days after last access |
| REST rate | 60 req/min per key (burst 10), 10 req/s per IP |
| Monthly reset date | Not documented; ask on Discord (K8) |

A 2,000-event run can't call Meko for every event. Agents score events locally, and only risk signals, non-trivial decisions and patterns reach Meko. Each run is also recorded to `runs/*.json`, so dashboard replays and metrics don't spend quota.
