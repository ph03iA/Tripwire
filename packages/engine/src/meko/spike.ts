// Week-1 checks against the real Meko account (docs/plan.md, K1–K11): npm run spike -- <check…>
// Everything runs in its own datapack, tripwire-spike, so the default datapack and the working ones stay clean.
// Each check saves every call it made to runs/spike/<check>.json. Never run in tests or CI: it spends real quota.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type MekoConfig, mekoConfig } from "../config.js";
import { connectMcp, type Mcp } from "./mcp.js";
import { MekoError, type Op } from "./retry.js";
import { type Rest, restClient } from "./rest.js";

const OUT = fileURLToPath(new URL("../../../../runs/spike/", import.meta.url));
const SPIKE_DATAPACK = "tripwire-spike";
const AGENT = {
  runner: "tripwire:runner",
  login: "tripwire:login",
  device: "tripwire:device",
  txn: "tripwire:txn",
  support: "tripwire:support",
  decision: "tripwire:decision",
  analyst: "tripwire:analyst",
};
const RETRIEVALS = ["memory_search", "knowledgebase_search", "context_search"];
/** Meko echoes the account owner's name and email in some answers; they never reach a saved file or the console. */
const PRIVATE = new Set(["user_id", "user_name", "user_email", "datapack_owner_name", "datapack_owner_email_id"]);

type Call = { tool: string; args: Record<string, unknown>; ms: number; out?: unknown; error?: string };
type Ctx = { cfg: MekoConfig; mcp: Mcp; rest: Rest; datapackId: string; calls: Call[] };
type Row = { id: string; data?: string; agent_id?: string; conversation_id?: string; created_at?: string };

const scrub = (key: string, value: unknown) => (PRIVATE.has(key) ? undefined : value);
const save = (name: string, data: unknown) => writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, scrub, 1) + "\n");
const earlier = (check: string) => JSON.parse(readFileSync(join(OUT, `${check}.json`), "utf8")).result;
const tag = () => Date.now().toString(36);
const failure = (err: Error) => ({ error: err.message });
const mentions = (out: unknown, text: string) => JSON.stringify(out).includes(text);

/** One MCP call in the spike datapack, recorded with its time and answer. */
async function call(ctx: Ctx, tool: string, args: Record<string, unknown>, op: Op = "read"): Promise<unknown> {
  const full = { datapack_id: ctx.datapackId, ...args };
  const record: Call = { tool, args: brief(full), ms: 0 };
  ctx.calls.push(record);
  const t0 = performance.now();
  try {
    record.out = await ctx.mcp.call(tool, full, op);
    return record.out;
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    record.ms = Math.round(performance.now() - t0);
  }
}

const brief = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}… (${v.length} chars)` : v]));

/** Every string under an `id`-like key, anywhere in an answer: the spike learns Meko's shapes rather than assuming them. */
function idsIn(x: unknown, keys = ["id", "memory_id", "conversation_id"]): string[] {
  if (Array.isArray(x)) return x.flatMap((v) => idsIn(v, keys));
  if (typeof x !== "object" || x === null) return [];
  return Object.entries(x).flatMap(([k, v]) => (keys.includes(k) && typeof v === "string" ? [v] : idsIn(v, keys)));
}

async function conversation(ctx: Ctx, title: string, agentId: string): Promise<string> {
  const out = await call(ctx, "conversation_create", { title: `tripwire spike: ${title}`, agent_id: agentId }, "write-once");
  const id = idsIn(out)[0];
  if (!id) throw new Error(`conversation_create: no id in ${JSON.stringify(out).slice(0, 300)}`);
  return id;
}

const signal = (agentId: string, conversationId: string, text: string, metadata: Record<string, string>) => ({
  text,
  conversation_id: conversationId,
  agent_id: agentId,
  metadata: JSON.stringify(metadata),
});

/** Polls `search` until `found` holds or the time runs out; returns how long it took. Every 2 s keeps under 60 calls a minute. */
async function pollUntil(search: () => Promise<unknown>, found: (out: unknown) => boolean, limitMs = 30_000, everyMs = 2000) {
  const t0 = Date.now();
  for (let polls = 1; ; polls++) {
    const out = await search();
    if (found(out)) return { found: true, ms: Date.now() - t0, polls, out };
    if (Date.now() - t0 + everyMs > limitMs) return { found: false, ms: Date.now() - t0, polls, out };
    await sleep(everyMs);
  }
}

const isPage = (x: unknown): x is { memories: Row[]; total_pages: number } =>
  typeof x === "object" && x !== null && "memories" in x && Array.isArray(x.memories) && "total_pages" in x && typeof x.total_pages === "number";
const slim = ({ id, data, agent_id, conversation_id, created_at }: Row) => ({ id, data, agent_id, conversation_id, created_at });

/** Every private memory in the spike datapack, across pages. */
async function everyMemory(ctx: Ctx, conversationId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; ; page++) {
    const out = await call(ctx, "memory_get_all", { conversation_id: conversationId, page, page_size: 100 });
    if (!isPage(out)) throw new Error(`memory_get_all: unexpected answer ${JSON.stringify(out).slice(0, 200)}`);
    rows.push(...out.memories);
    if (page >= out.total_pages) return rows;
  }
}

/** K1: a signal one agent writes about a device is found, by its ID, by another agent searching that device. */
async function k1(ctx: Ctx) {
  const run = await conversation(ctx, "k1", AGENT.runner);
  const device = `dev_k1${tag()}`;
  const key = "evt_k1a/device.new_device";
  const text = `Risk signal new_device, score 0.5, from the device agent: account acct_k1a logged in from device ${device}, which it had never used before. Key ${key}.`;
  const added = await call(ctx, "memory_add", signal(AGENT.device, run, text, { key, device, accountId: "acct_k1a" }), "write-once");
  const expected = idsIn(added, ["id", "memory_id"])[0];
  const search = () => call(ctx, "memory_search", { query: `risk signals about device ${device}`, conversation_id: run, agent_id: AGENT.login, run_id: run, limit: 5 });
  const hit = (out: unknown) => (expected ? idsIn(out).includes(expected) : mentions(out, key));
  const poll = await pollUntil(search, hit);
  const stored = (await everyMemory(ctx, run)).filter((row) => row.id === expected).map(slim);
  const unscoped = await call(ctx, "memory_search", { query: `risk signals about device ${device}`, conversation_id: run, agent_id: AGENT.txn, limit: 5 });
  const cleanup = await call(ctx, "memory_delete_all", { conversation_id: run, agent_id: AGENT.device, run_id: run }, "idempotent");
  return { run, device, expected, added, retrieved: { found: poll.found, afterMs: poll.ms, polls: poll.polls }, stored, unscopedFound: hit(unscoped), cleanup };
}

/** K2: a run's signals are found through its conversation (run_id) and deleted per agent; another run's stay. */
async function k2(ctx: Ctx) {
  const [runA, runB] = [await conversation(ctx, "k2 run A", AGENT.runner), await conversation(ctx, "k2 run B", AGENT.runner)];
  const device = `dev_k2${tag()}`;
  const agents = [AGENT.login, AGENT.device, AGENT.txn, AGENT.support];
  for (const [i, agent] of agents.entries()) {
    const text = `Risk signal from the ${agent} agent about device ${device}: suspicious activity number ${i + 1} in run B. Key evt_k2b${i}/${agent}.`;
    await call(ctx, "memory_add", signal(agent, runB, text, { key: `evt_k2b${i}`, device }), "write-once");
  }
  await call(ctx, "memory_add", signal(AGENT.device, runA, `Risk signal from the device agent about device ${device} in run A. Key evt_k2a/device.`, { key: "evt_k2a", device }), "write-once");
  const query = `risk signals about device ${device}`;
  const count = async (run?: string) => {
    const out = await call(ctx, "memory_search", { query, conversation_id: runB, agent_id: AGENT.login, limit: 10, ...(run ? { run_id: run } : {}) });
    return (JSON.stringify(out).match(/Key evt_k2/g) ?? []).length;
  };
  const indexed = await pollUntil(() => count(), (n) => n === 5);
  const before = { all: indexed.out, runB: await count(runB), runA: await count(runA) };
  const deletes = [];
  for (const agent of agents) deletes.push(await call(ctx, "memory_delete_all", { conversation_id: runB, agent_id: agent, run_id: runB }, "idempotent"));
  const after = { all: await count(), runB: await count(runB), runA: await count(runA) };
  const cleanup = await call(ctx, "memory_delete_all", { conversation_id: runA, agent_id: AGENT.device, run_id: runA }, "idempotent");
  return { runA, runB, indexedAfterMs: indexed.ms, before, deletes, after, afterCleanup: await count(), cleanup };
}

/** K4: what promotion needs and how to confirm it: promote at once, again later if needed, then promote a repeat. */
async function k4(ctx: Ctx) {
  const approval = await conversation(ctx, "k4 approval", AGENT.analyst);
  const marker = `k4${tag()}`;
  const text = `Approved fraud pattern ${marker}: card-testing ring. Many charges under 100 rupees at different merchants from one device within an hour, followed by a large payout to a new payee.`;
  const added = await call(ctx, "memory_add", signal(AGENT.analyst, approval, text, { kind: "pattern", marker }), "write-once");
  const id = idsIn(added, ["id"])[0];
  if (!id) throw new Error(`memory_add: no id in ${JSON.stringify(added).slice(0, 300)}`);
  const promote = () => call(ctx, "memory_promote", { conversation_id: approval, agent_id: AGENT.analyst, memory_ids: [id] }, "write-once");
  const listed = async () => mentions(await call(ctx, "memory_get_all", { conversation_id: approval, promoted: true, page_size: 100 }), id);
  const attempts = [];
  for (const waitMs of [0, 5000, 20_000]) {
    await sleep(waitMs);
    const attempt = { waitMs, answer: await promote(), listed: await listed() };
    attempts.push(attempt);
    if (attempt.listed) break;
  }
  const repeat = await promote();
  const privateRow = await call(ctx, "memory_get_by_id", { memory_id: id, conversation_id: approval, agent_id: AGENT.analyst }).catch(failure);
  return { id, marker, approval, attempts, repeat, listedAfterRepeat: await listed(), privateRow };
}

/** K3: which search returns the pattern k4 promoted: knowledgebase_search, memory_search or context_search. */
async function k3(ctx: Ctx) {
  const { marker } = earlier("k4") as { marker: string };
  const conv = await conversation(ctx, "k3 pattern search", AGENT.decision);
  const query = "card-testing ring: many small charges at different merchants from one device, then a large payout to a new payee";
  const found: Record<string, unknown> = {};
  for (const tool of RETRIEVALS) {
    const search = () => call(ctx, tool, { query, conversation_id: conv, agent_id: AGENT.decision, limit: 5 }).catch(failure);
    const poll = await pollUntil(search, (out) => mentions(out, marker), 60_000, 10_000);
    found[tool] = { found: poll.found, afterMs: poll.ms, polls: poll.polls };
  }
  return { marker, query, found };
}

/** K5: AMP on the Free plan, read-only (the vCPU budget and the clusters). Creating a database is the user's call. */
async function k5(ctx: Ctx) {
  const conv = await conversation(ctx, "k5 amp", AGENT.runner);
  const ask = (tool: string) => call(ctx, tool, { conversation_id: conv }).catch(failure);
  return { budget: await ask("amp_core_budget"), clusters: await ask("amp_cluster_list") };
}

/** K6: what Meko extracts from a trace turn, under which agent ID, and how long it takes: lists every memory for 5 minutes. */
async function k6(ctx: Ctx) {
  const caseRun = await conversation(ctx, "k6 case", AGENT.decision);
  const before = new Set((await everyMemory(ctx, caseRun)).map((row) => row.id));
  const message = await call(ctx, "conversation_add_message", {
    conversation_id: caseRun,
    agent_id: AGENT.decision,
    input: "Decision requested for event evt_k6a.",
    output: "STEP-UP on evt_k6a: account acct_k6a logged in from new device dev_k6x after 3 failed logins from IP 203.0.113.7. Risk 0.66 from login.failed-burst (0.4) and device.new-device (0.5).",
    reasoning: "Two independent signals on one device within 10 minutes. The policy steps up between 0.5 and 0.8.",
    plan: ["Recall signals for the account and the device", "Score the risk as a noisy-OR", "Step up with an OTP to the registered phone"],
  }, "write-once");
  const t0 = Date.now();
  const firstSeen = new Map<string, { afterMs: number; row: ReturnType<typeof slim> }>();
  for (let poll = 0; poll < 10; poll++) {
    await sleep(30_000);
    for (const row of await everyMemory(ctx, caseRun)) {
      if (!before.has(row.id) && !firstSeen.has(row.id)) firstSeen.set(row.id, { afterMs: Date.now() - t0, row: slim(row) });
    }
  }
  return { caseRun, message, extracted: [...firstSeen.values()] };
}

type KbHit = { document_id?: string; metadata_filters?: { memory_id?: string } };
const kbHits = (out: unknown): KbHit[] =>
  typeof out === "object" && out !== null && "results" in out && Array.isArray(out.results) ? out.results : [];

/** K7: can the pattern k4 promoted be deleted? By memory ID first, then as the knowledge-base document it became. */
async function k7(ctx: Ctx) {
  const { id, approval, marker } = earlier("k4") as { id: string; approval: string; marker: string };
  const { query } = earlier("k3") as { query: string };
  const search = () => call(ctx, "knowledgebase_search", { query, conversation_id: approval, agent_id: AGENT.decision, limit: 5 });
  const state = async () => {
    const promoted = await call(ctx, "memory_get_all", { conversation_id: approval, promoted: true, page_size: 100 });
    return { promoted: mentions(promoted, id), searchable: mentions(await search(), marker) };
  };
  const documentId = kbHits(await search()).find((hit) => hit.metadata_filters?.memory_id === id)?.document_id;
  const byMemoryId = await call(ctx, "memory_delete_by_id", { memory_id: id, conversation_id: approval, agent_id: AGENT.analyst }, "idempotent").catch(failure);
  const afterMemoryDelete = await state();
  if (!documentId) return { documentId, byMemoryId, afterMemoryDelete };
  const byDocument = await call(ctx, "knowledgebase_delete_document", { document_id: documentId, conversation_id: approval }, "idempotent").catch(failure);
  // REST deletes uploaded files only; check whether a promoted pattern is listed as one.
  const files = `datapacks/${ctx.datapackId}/knowledge-bases/documents`;
  const listedAsFile = mentions(await ctx.rest.request<unknown>("GET", files, "read").catch(failure), documentId);
  const byRest = listedAsFile ? await ctx.rest.request("DELETE", `${files}/${documentId}`, "idempotent").catch(failure) : "not listed as a file";
  await sleep(5000);
  return { documentId, byMemoryId, afterMemoryDelete, byDocument, listedAsFile, byRest, afterDocumentDelete: await state() };
}

/**
 * K10: a ~150-line allow-ledger turn is stored whole. Also whether Meko dedupes conversation writes: the same seed
 * twice for a message, and the same session_id twice for a conversation, which decides whether they can be retried.
 */
async function k10(ctx: Ctx) {
  const session = { title: "tripwire spike: k10 allow ledger", agent_id: AGENT.decision, session_id: `k10-${tag()}` };
  const created = [await call(ctx, "conversation_create", session, "write-once"), await call(ctx, "conversation_create", session, "write-once")];
  const ledger = idsIn(created[0])[0];
  if (!ledger) throw new Error(`conversation_create: no id in ${JSON.stringify(created[0]).slice(0, 300)}`);
  const lines = Array.from({ length: 150 }, (_, i) => {
    const time = `2026-11-01T${String(8 + Math.floor(i / 12)).padStart(2, "0")}:${String((i * 5) % 60).padStart(2, "0")}`;
    return `${time} ALLOW evt_${String(i).padStart(5, "0")} acct_${String(i % 40).padStart(3, "0")} login risk 0.${i % 5} signals: ${i % 3 ? "none" : "login.new-ip (0.2)"} searches: ${i % 4}`;
  });
  const output = lines.join("\n");
  const turn = { conversation_id: ledger, agent_id: AGENT.decision, input: "Allow ledger for 2026-11-01.", output, seed: `k10-${tag()}` };
  const first = await call(ctx, "conversation_add_message", turn, "write-once");
  const repeat = await call(ctx, "conversation_add_message", turn, "write-once");
  const read = () => call(ctx, "conversation_get", { conversation_id: ledger, agent_id: AGENT.decision, include_messages: true });
  const poll = await pollUntil(read, (out) => mentions(out, "evt_00149"), 60_000, 5000);
  await sleep(15_000); // the turns are written in the background: give the repeat time to land too
  const stored = await read();
  return {
    sameSessionSameConversation: ledger === idsIn(created[1])[0],
    created,
    lines: lines.length,
    chars: output.length,
    first,
    repeat,
    storedAfterMs: poll.ms,
    storedWhole: poll.found,
    copiesOfLastLine: (JSON.stringify(stored).match(/evt_00149/g) ?? []).length,
  };
}

/** K11: searches tagged with a case's conversation_id, in this datapack and in another, to look for in the portal trace. */
async function k11(ctx: Ctx) {
  const caseRun = await conversation(ctx, "k11 case: check its trace in the portal", AGENT.decision);
  const other = (await datapacks(ctx.rest)).find((d) => d.datapack_id !== ctx.datapackId && d.datapack_name !== SPIKE_DATAPACK);
  const search = (tool: string, datapackId = ctx.datapackId) =>
    call(ctx, tool, { datapack_id: datapackId, query: "risk signals about device dev_k11", conversation_id: caseRun, agent_id: AGENT.decision, limit: 3 }).then(() => "ok", (err: Error) => err.message);
  return {
    caseRun,
    memorySearch: await search("memory_search"),
    knowledgebaseSearch: await search("knowledgebase_search"),
    otherDatapack: other ? { name: other.datapack_name, memorySearch: await search("memory_search", other.datapack_id) } : "no other datapack",
  };
}

/** What the spike datapack holds now: private memories by agent and conversation, with one example each (for K6). */
async function inventory(ctx: Ctx) {
  const conv = await conversation(ctx, "inventory", AGENT.runner);
  const groups = new Map<string, { count: number; example?: string }>();
  for (const row of await everyMemory(ctx, conv)) {
    const key = `${row.agent_id} / ${row.conversation_id}`;
    const group = groups.get(key) ?? { count: 0, example: row.data };
    group.count++;
    groups.set(key, group);
  }
  return Object.fromEntries(groups);
}

/** K8: what the saved checks spent, by tool. The monthly reset date is a question for the Meko Discord. */
async function k8() {
  const byTool = new Map<string, number>();
  for (const file of readdirSync(OUT).filter((f) => /^k\d+\.json$/.test(f) && f !== "k8.json")) {
    const calls: Call[] = JSON.parse(readFileSync(join(OUT, file), "utf8")).calls ?? [];
    for (const c of calls) byTool.set(c.tool, (byTool.get(c.tool) ?? 0) + 1);
  }
  const sum = (tools: string[]) => tools.reduce((n, tool) => n + (byTool.get(tool) ?? 0), 0);
  return { byTool: Object.fromEntries(byTool), retrievals: sum(RETRIEVALS), conversationMessages: sum(["conversation_add_message"]) };
}

/** K9: Node connects with our headers: MCP lists its tools and REST answers. Nothing is written. */
async function k9({ mcp, rest }: Ctx) {
  const tools = await mcp.tools();
  save("k9-tools", tools);
  return { tools: tools.map((t) => t.name), datapacks: (await datapacks(rest)).length };
}

type Datapack = { datapack_id: string; datapack_name: string };
const isDatapacks = (x: unknown): x is Datapack[] =>
  Array.isArray(x) && x.every((d) => typeof d?.datapack_id === "string" && typeof d?.datapack_name === "string");

async function datapacks(rest: Rest): Promise<Datapack[]> {
  const list = await rest.request<unknown>("GET", "datapacks", "read");
  if (!isDatapacks(list)) throw new Error(`GET /datapacks: unexpected answer ${JSON.stringify(list, scrub).slice(0, 200)}`);
  return list;
}

/**
 * The spike's datapack, created on first use over REST (MCP's datapack_create needs a conversation, which needs a
 * datapack). A repeat answers 409, so the create is safe to retry. The Free plan allows 10 datapacks ever.
 */
async function spikeDatapack(rest: Rest): Promise<string> {
  const find = async () => (await datapacks(rest)).find((d) => d.datapack_name === SPIKE_DATAPACK)?.datapack_id;
  const existing = await find();
  if (existing) return existing;
  const body = { name: SPIKE_DATAPACK, description: "Tripwire week-1 checks (docs/spikes.md). Disposable test data." };
  await rest.request("POST", "datapacks", "idempotent", body).catch((err: unknown) => {
    if (!(err instanceof MekoError && err.status === 409)) throw err;
  });
  const created = await find();
  if (!created) throw new Error(`POST /datapacks answered, but ${SPIKE_DATAPACK} isn't listed`);
  return created;
}

const CHECKS: Record<string, (ctx: Ctx) => Promise<unknown>> = { k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, inventory };

const wanted = process.argv.slice(2);
const unknown = wanted.filter((id) => !CHECKS[id]);
if (wanted.length === 0 || unknown.length > 0) {
  console.error(`usage: npm run spike -- <check…>, from: ${Object.keys(CHECKS).join(" ")}${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const cfg = mekoConfig();
const mcp = await connectMcp(cfg);
const rest = restClient(cfg);
try {
  const ctx: Ctx = { cfg, mcp, rest, datapackId: await spikeDatapack(rest), calls: [] };
  for (const id of wanted) {
    ctx.calls = [];
    const t0 = Date.now();
    const result = await CHECKS[id]!(ctx).catch(failure);
    save(id, { ranAt: new Date(t0).toISOString(), ms: Date.now() - t0, result, calls: ctx.calls });
    console.log(`${id} (${Date.now() - t0} ms): ${JSON.stringify(result, scrub).slice(0, 1200)}`);
  }
} finally {
  console.log(`calls: mcp ${JSON.stringify(Object.fromEntries(mcp.calls))}, rest ${JSON.stringify(Object.fromEntries(rest.calls))}`);
  await mcp.close();
}
