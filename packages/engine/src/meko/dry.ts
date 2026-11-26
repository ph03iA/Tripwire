import { basename } from "node:path";
import { knowledgeFiles, playbookFiles, POLICY_FILE } from "../knowledge/upload.js";
import type { Mcp } from "./mcp.js";
import { MekoError } from "./retry.js";

type Memory = { id: string; data: string; agent_id: string; conversation_id: string; run_id?: string; metadata?: unknown };
type Message = { id: string; seed?: string; input: string; output: string };
type Conversation = { id: string; agent_id: string; title: string; messages: Message[] };
type Args = Record<string, unknown>;

/** The words a memory search matches on: IDs like acc_0042 or dev_9f3a, and IP addresses. */
const ID_WORD = /\b(?:[a-z]{3}_[0-9a-z]+|\d{1,3}(?:\.\d{1,3}){3})\b/g;

export type DryMeko = Mcp & { memories: Map<string, Memory>; conversations: Map<string, Conversation> };

/** The stand-in's knowledge base holds every knowledge doc, under these IDs. */
const dryId = (file: string) => `dry:${basename(file)}`;
export const dryDocuments = () => ({ policy: dryId(POLICY_FILE), playbooks: playbookFiles().map(dryId) });

/**
 * An in-process stand-in for Meko's MCP tools, with the answer shapes the live API gave in the week-1 checks.
 * `--meko dry` runs the whole ON pipeline against it to count the calls a run needs before spending quota
 * (spec §6), and the tests use it as their Meko. Its search is ideal keyword matching, so a live run can only
 * retrieve less. Like Meko (K6), it saves a memory from each turn's user input, so the R8 audit has work to do.
 */
export function dryMeko(): DryMeko {
  const memories = new Map<string, Memory>();
  const conversations = new Map<string, Conversation>();
  const calls = new Map<string, number>();
  let n = 0;
  const next = (prefix: string) => `${prefix}-${String(++n).padStart(6, "0")}`;
  const conversation = (a: Args) => {
    const c = conversations.get(String(a.conversation_id));
    if (!c) throw new MekoError("not_found");
    return c;
  };

  const tools: Record<string, (a: Args) => unknown> = {
    conversation_create(a) {
      const id = typeof a.session_id === "string" ? a.session_id : next("conv");
      if (!conversations.has(id)) conversations.set(id, { id, agent_id: String(a.agent_id), title: String(a.title), messages: [] });
      return { id, agent_id: a.agent_id, title: a.title };
    },
    conversation_get: (a) => conversation(a),
    conversation_add_message(a) {
      const c = conversation(a);
      const repeat = c.messages.find((m) => a.seed !== undefined && m.seed === a.seed);
      if (repeat) return { status: "accepted", message_id: repeat.id, conversation_id: c.id };
      const message = { id: next("msg"), seed: a.seed as string | undefined, input: String(a.input), output: String(a.output) };
      c.messages.push(message);
      const id = next("mem");
      memories.set(id, { id, data: `User asked: ${message.input}`, agent_id: c.agent_id, conversation_id: c.id }); // K6
      return { status: "accepted", message_id: message.id, conversation_id: c.id }; // Meko's receipt (K10)
    },
    memory_add(a) {
      const id = next("mem");
      const conversationId = String(a.conversation_id);
      memories.set(id, { id, data: String(a.text), agent_id: String(a.agent_id), conversation_id: conversationId, run_id: conversationId,
        metadata: typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata });
      return { results: [{ id, memory: a.text, event: "ADD" }] };
    },
    memory_search(a) {
      const words = new Set(String(a.query).match(ID_WORD) ?? []);
      const hits = [...memories.values()].filter((m) => a.run_id === undefined || m.run_id === a.run_id)
        .map((m) => ({ m, score: [...words].filter((w) => m.data.includes(w)).length }))
        .filter((h) => h.score > 0)
        .sort((x, y) => y.score - x.score);
      return { results: hits.slice(0, Number(a.limit ?? 10)).map(({ m, score }) => ({ id: m.id, memory: m.data, metadata: m.metadata, score })) };
    },
    knowledgebase_search(a) {
      // One passage from every knowledge doc, in file order: the trace has to pick the right document itself.
      const results = knowledgeFiles().slice(0, Number(a.limit ?? 10)).map((f) => ({ id: next("chunk"), document_id: dryId(f),
        chunk_text: `(dry run) a passage of ${basename(f)} for "${String(a.query)}"`, metadata_filters: { source: "upload" } }));
      return { results, count: results.length };
    },
    memory_delete_all(a) {
      const doomed = [...memories.values()].filter((m) => m.agent_id === a.agent_id && (a.run_id === undefined || m.run_id === a.run_id));
      for (const m of doomed) memories.delete(m.id);
      return { deleted_count: doomed.length, complete: true };
    },
    memory_get_all(a) {
      const size = Number(a.page_size ?? 100);
      const page = Number(a.page ?? 1);
      const all = [...memories.values()];
      return { memories: all.slice((page - 1) * size, page * size), page, total_pages: Math.max(1, Math.ceil(all.length / size)) };
    },
    memory_delete_by_id: (a) => ({ deleted: memories.delete(String(a.memory_id)) }),
  };

  return {
    calls,
    memories,
    conversations,
    async call(tool, args) {
      calls.set(tool, (calls.get(tool) ?? 0) + 1);
      const run = tools[tool];
      if (!run) throw new MekoError(`${tool}: not in the dry-run stand-in`);
      try {
        return structuredClone(run(args));
      } catch (err) {
        throw err instanceof MekoError ? new MekoError(`${tool}: ${err.message}`) : err;
      }
    },
    tools: async () => [],
    close: async () => {},
  };
}
