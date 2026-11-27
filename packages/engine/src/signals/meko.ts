import { setTimeout as sleep } from "node:timers/promises";
import type { Mcp } from "../meko/mcp.js";
import { UnknownOutcomeError, type Wait } from "../meko/retry.js";
import type { AgentName, RiskSignal, TripwireEvent } from "../types.js";
import { namesEntity } from "../agents/judgment.js";
import { inWindow, isRelevant, type SignalStore } from "./local.js";

export const SIGNALS_DATAPACK = "tripwire-signals";
const SEARCH_LIMIT = 20;
const FRESH_MS = 30_000; // A7: a signal written this recently may not be searchable yet
const SEARCH_AGAIN_AFTER_MS = [2000, 4000];
const KEY_LOOKUP_AFTER_MS = [0, 2000, 3000]; // about 5 s (spec §6)

/** One Meko search made for an event, kept in its decision record (PRD C3). */
export type Retrieval = {
  eventId: string;
  agent: string; // the Meko agent ID that searched
  tool: "memory_search" | "knowledgebase_search";
  datapack: string;
  conversationId: string; // the account's case, so the portal shows the search in its trace (K11)
  query: string;
  returnedIds: string[];
  usedIds: string[]; // the returned ones this run wrote, naming the same entity, inside 72 h
  timedOut?: string[]; // this run's fresh signals the event should see, still missing after the repeat searches (A7)
};

export type MekoSignalOptions = {
  mcp: Mcp;
  datapackId: string;
  run: string; // the run conversation: signals are written under it, and searched with run_id set to it (K2)
  caseFor(accountId: string): Promise<string>;
  log(r: Retrieval): void;
  wait?: Wait;
  now?: () => number; // wall clock, only to tell a signal still being indexed from one search didn't rank
};

/** The ON store also knows which memories this run wrote: the only ones it trusts, and all the R8 audit keeps. */
export type MekoSignalStore = SignalStore & { trusted: Set<string> };

const agentId = (name: AgentName | "decision") => `tripwire:${name}`;
const keyOf = (s: RiskSignal) => `${s.eventId}/${s.ruleId}`;
const ENTITY_WORDS = [["deviceId", "device"], ["ip", "ip"], ["payeeId", "payee"], ["merchantId", "merchant"]] as const;

/** One line naming every entity, so Meko's keyword search finds it by any of them (PRD A5). */
function lineOf(s: RiskSignal): string {
  const entities = ENTITY_WORDS.flatMap(([field, word]) => (s.entities[field] ? [`${word} ${s.entities[field]}`] : [])).join(" ");
  return `[signal][${s.agent}] ${s.accountId} ${s.type} ${s.score} ${entities}: ${s.evidence} (${keyOf(s)}, ${s.ts})`;
}

/** The account and the device, IP and payee recall matches on (the merchant isn't one). */
function queryFor(e: TripwireEvent): string {
  const linked = "deviceId" in e ? [e.deviceId, e.ip, e.kind === "transaction" ? e.payeeId : undefined] : [];
  return `risk signals about ${[e.accountId, ...linked].filter(Boolean).join(", ")}`;
}

/**
 * ON mode (PRD A5–A7): every agent's signals go to one Meko datapack, so each agent sees everyone's. An event gets
 * at most one memory search, made when an agent or the decision agent first needs it, and shared by all of them,
 * since they would all ask the same thing. A result counts only if this run wrote it (R8), it names the same entity,
 * and it falls inside 72 hours.
 */
export function mekoSignals(o: MekoSignalOptions): MekoSignalStore {
  const { mcp, datapackId, run, wait = sleep, now = Date.now } = o;
  const written = new Map<string, { signal: RiskSignal; at: number }>();
  const trusted = new Set<string>();
  let latest: { eventId: string; signals: Promise<RiskSignal[]> } | undefined;

  const shared = (agent: AgentName | "decision", e: TripwireEvent) => {
    if (latest?.eventId !== e.id) latest = { eventId: e.id, signals: searchFor(agent, e) };
    return latest.signals;
  };

  async function searchFor(agent: AgentName | "decision", e: TripwireEvent): Promise<RiskSignal[]> {
    const conversationId = await o.caseFor(e.accountId);
    let found = await search(agent, e, conversationId);
    for (const ms of SEARCH_AGAIN_AFTER_MS) {
      if (found.missing.length === 0) break;
      await wait(ms);
      found = await search(agent, e, conversationId);
    }
    if (found.missing.length) found.retrieval.timedOut = found.missing;
    return found.used;
  }

  async function search(agent: AgentName | "decision", e: TripwireEvent, conversationId: string) {
    const query = queryFor(e);
    const out = await mcp.call("memory_search", { datapack_id: datapackId, conversation_id: conversationId, agent_id: agentId(agent),
      run_id: run, query, limit: SEARCH_LIMIT }, "read");
    const returnedIds = hitIds(out);
    const used = returnedIds.flatMap((id) => {
      const s = written.get(id)?.signal;
      return s && isRelevant(s, e) ? [s] : [];
    });
    const retrieval: Retrieval = { eventId: e.id, agent: agentId(agent), tool: "memory_search", datapack: SIGNALS_DATAPACK, conversationId, query,
      returnedIds, usedIds: used.map((s) => s.memoryId!) };
    o.log(retrieval);
    return { retrieval, used, missing: missingFresh(e, new Set(returnedIds)) };
  }

  /** need_more's one search, by the entity's words (signals name "device dev_1" and the like), filed under the case. */
  async function entitySearch(e: TripwireEvent, entity: string): Promise<RiskSignal[]> {
    const conversationId = await o.caseFor(e.accountId);
    const query = entity.replace(":", " ");
    const out = await mcp.call("memory_search", { datapack_id: datapackId, conversation_id: conversationId, agent_id: agentId("decision"), run_id: run,
      query, limit: SEARCH_LIMIT }, "read");
    const returnedIds = hitIds(out);
    const found = returnedIds.flatMap((id) => (written.has(id) ? [written.get(id)!.signal] : []));
    o.log({ eventId: e.id, agent: agentId("decision"), tool: "memory_search", datapack: SIGNALS_DATAPACK, conversationId, query, returnedIds,
      usedIds: found.map((s) => s.memoryId!) });
    return found;
  }

  /** Signals this run wrote in the last 30 s that the event should see but the search didn't return: probably not indexed yet. */
  const missingFresh = (e: TripwireEvent, returned: Set<string>) =>
    [...written].filter(([id, w]) => !returned.has(id) && w.signal.eventId !== e.id && now() - w.at <= FRESH_MS && isRelevant(w.signal, e))
      .map(([id]) => id);

  /** memory_add stores duplicates, so a write whose answer was lost is looked up by its key, never resent (spec §6). */
  async function afterUnknownOutcome(err: unknown, key: string): Promise<string> {
    if (!(err instanceof UnknownOutcomeError)) throw err;
    for (const ms of KEY_LOOKUP_AFTER_MS) {
      await wait(ms);
      const id = await memoryWithKey(key);
      if (id) return id;
    }
    throw new Error(`memory_add for ${key}: the outcome is unknown and the signal isn't in Meko, so the run stops rather than risk writing it twice`);
  }

  /** memory_get_all isn't a search, so the lookup spends no search quota. */
  async function memoryWithKey(key: string): Promise<string | undefined> {
    for (let page = 1; ; page++) {
      const out = await mcp.call("memory_get_all", { datapack_id: datapackId, conversation_id: run, page, page_size: 100 }, "read");
      if (!isPage(out)) throw new Error("memory_get_all: unexpected answer");
      const row = out.memories.find((m) => typeof m.data === "string" && m.data.includes(`(${key},`));
      if (row) return row.id;
      if (page >= out.total_pages) return undefined;
    }
  }

  return {
    trusted,
    async write(s) {
      const key = keyOf(s);
      const id = await mcp.call("memory_add", { datapack_id: datapackId, conversation_id: run, agent_id: agentId(s.agent), text: lineOf(s),
        metadata: JSON.stringify({ key, accountId: s.accountId, ...s.entities }) }, "write-once").then(receiptId, (err) => afterUnknownOutcome(err, key));
      s.memoryId = id; // the record's copy of the signal carries its Meko ID
      written.set(id, { signal: s, at: now() });
      trusted.add(id);
    },
    recall: shared,
    forDecision: async (_owner, e) => (await shared("decision", e)).filter((s) => s.eventId !== e.id),
    sees: () => true,
    lookup: async (_owner, e, entity) => {
      const names = namesEntity(entity);
      return names ? (await entitySearch(e, entity)).filter((s) => names(s) && inWindow(s, e)) : [];
    },
  };
}

type Page = { memories: { id: string; data?: unknown; agent_id?: string }[]; total_pages: number };
export const isPage = (x: unknown): x is Page =>
  typeof x === "object" && x !== null && "memories" in x && Array.isArray(x.memories) && "total_pages" in x && typeof x.total_pages === "number";

function receiptId(out: unknown): string {
  const id = (out as { results?: { id?: unknown }[] } | null)?.results?.[0]?.id;
  if (typeof id !== "string") throw new Error("memory_add: no memory ID in the answer");
  return id;
}

function hitIds(out: unknown): string[] {
  const results = (out as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error("memory_search: unexpected answer");
  return results.flatMap((r: { id?: unknown }) => (typeof r?.id === "string" ? [r.id] : []));
}
