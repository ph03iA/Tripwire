import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { UNREVIEWED, type Verdict } from "../agents/decision.js";
import { PATTERNS_DATAPACK } from "../knowledge/upload.js";
import type { Mcp } from "../meko/mcp.js";
import { classify, type Wait } from "../meko/retry.js";
import { isPage, type Retrieval, SIGNALS_DATAPACK } from "../signals/meko.js";
import type { TripwireEvent } from "../types.js";

export type Quote = { documentId: string; text: string };

const RUNNER = "tripwire:runner";
const DECISION = "tripwire:decision";
/** Every agent that can leave memories in the signals datapack: the four that write signals, and the one whose turns Meko mines (K6). */
const RESET_AGENTS = ["tripwire:login", "tripwire:device", "tripwire:txn", "tripwire:support", DECISION];
const EXTRACTION_SETTLE_MS = 60_000; // K6: Meko saves a memory from a turn within about 30 s
const TURN_READABLE_AFTER_MS = 10_000; // K10: a turn shows in conversation_get about 8 s after the call
const LEDGER_PART_CHARS = 12_000; // K10 stored a 13,149-character turn whole
const QUOTE_CHARS = 400;
const DELETE_ROUNDS = 20;
// R8: a turn's user input is mined for a memory, so it is fixed and says nothing; the details go in output and reasoning.
const FLAGGED_INPUT = "Explain the flagged decision recorded in this turn.";
const LEDGER_INPUT = "File the allow ledger recorded in this turn.";

/** What a decision's trace turn holds: the decision record, with its reasoning and plan sent alongside (PRD C4). */
export type TraceTurn = { eventId: string; action: "STEP_UP" | "BLOCK"; outcome: string; reasoning: string; record: unknown };

/** What the runner needs from Meko besides signals. OFF mode gets `noTrace`, which makes no calls at all. */
export type Trace = {
  run: string; // the run conversation
  caseFor(accountId: string): Promise<string>;
  caseOf(accountId: string): string | undefined;
  log(r: Retrieval): void;
  retrievalsFor(eventId: string): Retrieval[];
  quotes(e: TripwireEvent, v: Verdict): Promise<Quote[]>;
  flagged(turn: TraceTurn, accountId: string): Promise<void>;
  ledger(ts: string, line: string): Promise<void>;
  finish(trusted: Set<string>): Promise<{ kept: number; deleted: number }>;
  conversations(): { run: string; ledger: string; cases: Record<string, string> };
};

export const noTrace: Trace = {
  run: "",
  caseFor: async () => "",
  caseOf: () => undefined,
  log: () => {},
  retrievalsFor: () => [],
  quotes: async () => [],
  flagged: async () => {},
  ledger: async () => {},
  finish: async () => ({ kept: 0, deleted: 0 }),
  conversations: () => ({ run: "", ledger: "", cases: {} }),
};

export type TraceOptions = {
  mcp: Mcp;
  runId: string;
  datapacks: { signals: string; patterns: string };
  wait?: Wait;
  now?: () => number;
  progress?: (line: string) => void;
};

/** A hex session_id becomes the conversation ID unchanged (K10), so every ID is known before its conversation exists. */
const sessionId = (runId: string, key: string) => createHash("sha256").update(`${runId}:${key}`).digest("hex").slice(0, 32);

const PLAN = {
  BLOCK: "Risk is 0.8 or more: refuse the action and lock out the device that made it",
  STEP_UP: "Risk is from 0.5 up to 0.8: send a one-time code to the registered phone",
};

/**
 * Opens an ON run in Meko (PRD R5, C4, C5, R8). It creates the run and ledger conversations, then deletes every
 * memory the four detection agents and the decision agent left in the signals datapack. During the run it opens one
 * case conversation per account, at the account's first Meko call, writes a turn for every STEP-UP and BLOCK, and
 * writes the daily allow ledger. `finish` runs the R8 audit.
 */
export async function openTrace(o: TraceOptions): Promise<Trace> {
  const { mcp, runId, datapacks, wait = sleep, now = Date.now } = o;
  const inSignals = { datapack_id: datapacks.signals };
  const retrievals: Retrieval[] = [];
  const cases = new Map<string, Promise<string>>();
  const resolved = new Map<string, string>();
  let lastConversationCall = now();
  let ledgerDay: string | undefined;
  let ledgerLines: string[] = [];

  async function conversation(key: string, title: string, agentId: string): Promise<string> {
    const id = sessionId(runId, key);
    const out = await mcp.call("conversation_create", { ...inSignals, title, agent_id: agentId, session_id: id }, "idempotent").catch(async (err: unknown) => {
      if (classify(err) === "permanent") throw err;
      // The outcome is unknown: the conversation exists if Meko knows its ID (an unknown one answers not_found, K10).
      await mcp.call("conversation_get", { ...inSignals, conversation_id: id, agent_id: agentId }, "read");
      return { id };
    });
    if ((out as { id?: unknown } | null)?.id !== id) throw new Error(`conversation_create didn't keep the session_id as the conversation ID (K10 changed)`);
    return id;
  }

  /** Conversation writes carry a seed, so a retry stores nothing new; after an unknown outcome the turn is looked up (spec §6). */
  async function addTurn(args: Record<string, unknown>, marker: string) {
    try {
      await mcp.call("conversation_add_message", { ...inSignals, ...args }, "idempotent").catch(async (err: unknown) => {
        if (classify(err) === "permanent") throw err;
        await wait(TURN_READABLE_AFTER_MS);
        const got = await mcp.call("conversation_get", { ...inSignals, conversation_id: args.conversation_id, agent_id: args.agent_id,
          include_messages: true }, "read");
        if (!JSON.stringify(got).includes(marker)) throw new Error(`a trace turn (${marker}) may be missing after an unknown outcome, so the run stops (C4)`);
      });
    } finally {
      lastConversationCall = now();
    }
  }

  /** memory_delete_all deletes in batches and says when it's done. */
  async function deleteAll(agentId: string): Promise<number> {
    let deleted = 0;
    for (let round = 0; round < DELETE_ROUNDS; round++) {
      const out = await mcp.call("memory_delete_all", { ...inSignals, conversation_id: run, agent_id: agentId }, "idempotent") as
        { deleted_count?: unknown; complete?: unknown } | null;
      deleted += typeof out?.deleted_count === "number" ? out.deleted_count : 0;
      if (out?.complete === true) return deleted;
    }
    throw new Error(`memory_delete_all for ${agentId} never reported complete`);
  }

  async function everyMemory() {
    const rows: { id: string; agent_id?: string }[] = [];
    for (let page = 1; ; page++) {
      const out = await mcp.call("memory_get_all", { ...inSignals, conversation_id: run, page, page_size: 100 }, "read");
      if (!isPage(out)) throw new Error("memory_get_all: unexpected answer");
      rows.push(...out.memories);
      if (page >= out.total_pages) return rows;
    }
  }

  async function flushLedger() {
    if (!ledgerDay || ledgerLines.length === 0) return;
    const parts = packLines(ledgerLines, LEDGER_PART_CHARS);
    for (const [i, part] of parts.entries()) {
      const header = `Allow ledger for ${ledgerDay}, part ${i + 1} of ${parts.length}, run ${runId}. Times are UTC; ALLOW unreviewed means ${UNREVIEWED}.`;
      await addTurn({ conversation_id: ledger, agent_id: DECISION, input: LEDGER_INPUT, output: `${header}\n${part}`,
        seed: `${runId}:ledger:${ledgerDay}:${i + 1}` }, header);
    }
    o.progress?.(`${ledgerDay}: ${ledgerLines.length} events in the ledger; Meko calls so far ${JSON.stringify(Object.fromEntries(mcp.calls))}`);
    ledgerLines = [];
  }

  async function passage(e: TripwireEvent, query: string): Promise<Quote | undefined> {
    const conversationId = await caseFor(e.accountId);
    const out = await mcp.call("knowledgebase_search", { datapack_id: datapacks.patterns, conversation_id: conversationId, agent_id: DECISION,
      query, limit: 3 }, "read");
    const hits = kbHits(out);
    const hit = hits.find((h) => h.metadata_filters?.source !== "memory"); // a learned pattern isn't a playbook passage (K3)
    retrievals.push({ eventId: e.id, agent: DECISION, tool: "knowledgebase_search", datapack: PATTERNS_DATAPACK, conversationId, query,
      returnedIds: hits.map((h) => h.id), usedIds: hit ? [hit.id] : [] });
    return hit && { documentId: hit.document_id, text: hit.chunk_text.length > QUOTE_CHARS ? `${hit.chunk_text.slice(0, QUOTE_CHARS)}…` : hit.chunk_text };
  }

  function caseFor(accountId: string): Promise<string> {
    let id = cases.get(accountId);
    if (!id) {
      id = conversation(`case:${accountId}`, `case ${accountId}, run ${runId}`, DECISION).then((c) => (resolved.set(accountId, c), c));
      cases.set(accountId, id);
    }
    return id;
  }

  const run = await conversation("run", `tripwire run ${runId}`, RUNNER);
  const ledger = await conversation("ledger", `allow ledger, run ${runId}`, DECISION);
  for (const agentId of RESET_AGENTS) await deleteAll(agentId); // R5: each run starts with an empty signals datapack

  return {
    run,
    caseFor,
    caseOf: (accountId) => resolved.get(accountId),
    log: (r) => void retrievals.push(r),
    retrievalsFor: (eventId) => retrievals.filter((r) => r.eventId === eventId),
    async quotes(e, v) {
      const playbook = await passage(e, `fraud playbook: ${v.used.map((s) => s.type.replaceAll("_", " ")).join(", ") || e.kind}`);
      const policy = await passage(e, `step-up policy: ${v.action === "BLOCK" ? "BLOCK" : "STEP-UP"} at risk ${v.risk.toFixed(2)}`);
      return [playbook, policy].filter((q): q is Quote => q !== undefined);
    },
    async flagged(turn, accountId) {
      const header = `Decision for ${turn.eventId}`;
      await addTurn({ conversation_id: await caseFor(accountId), agent_id: DECISION, input: FLAGGED_INPUT,
        output: `${header}\n${JSON.stringify(turn.record, null, 1)}`, reasoning: turn.reasoning,
        plan: ["Recall the signals on the account, its device, IP and payee from the last 72 hours",
          "Combine the strongest signal of each type as a noisy-OR", PLAN[turn.action], `Outcome: ${turn.outcome}`],
        seed: `${runId}:${turn.eventId}` }, header);
    },
    async ledger(ts, line) {
      const day = ts.slice(0, 10);
      if (ledgerDay !== undefined && day !== ledgerDay) await flushLedger();
      ledgerDay = day;
      ledgerLines.push(line);
    },
    /** R8: once Meko has had time to mine the last turn, delete what it mined, then check that only this run's signals are left. */
    async finish(trusted) {
      await flushLedger();
      const quiet = EXTRACTION_SETTLE_MS - (now() - lastConversationCall);
      if (quiet > 0) await wait(quiet);
      let deleted = await deleteAll(DECISION);
      for (const m of (await everyMemory()).filter((row) => !trusted.has(row.id))) {
        await mcp.call("memory_delete_by_id", { ...inSignals, conversation_id: run, agent_id: m.agent_id, memory_id: m.id }, "idempotent");
        deleted++;
      }
      const left = (await everyMemory()).filter((row) => !trusted.has(row.id)).length;
      if (left) throw new Error(`hygiene audit (R8): ${left} memories that aren't this run's signals are still in ${SIGNALS_DATAPACK}`);
      return { kept: trusted.size, deleted };
    },
    conversations: () => ({ run, ledger, cases: Object.fromEntries(resolved) }),
  };
}

/** Lines packed into parts of at most `max` characters, in order. */
function packLines(lines: string[], max: number): string[] {
  const parts: string[] = [];
  let part = "";
  for (const line of lines) {
    if (part && part.length + 1 + line.length > max) {
      parts.push(part);
      part = "";
    }
    part = part ? `${part}\n${line}` : line;
  }
  return part ? [...parts, part] : parts;
}

type KbHit = { id: string; chunk_text: string; document_id: string; metadata_filters?: { source?: string } };
function kbHits(out: unknown): KbHit[] {
  const results = (out as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error("knowledgebase_search: unexpected answer");
  return results.filter((r): r is KbHit => typeof r?.id === "string" && typeof r.chunk_text === "string" && typeof r.document_id === "string");
}
