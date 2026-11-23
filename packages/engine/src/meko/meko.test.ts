import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { mekoConfig, USER_AGENT } from "../config.js";
import { connectMcp, mcpOver } from "./mcp.js";
import { restClient } from "./rest.js";
import { classify, MekoError, retryAfterMs, UnknownOutcomeError, withRetry } from "./retry.js";

const KEY = "mko_tkn_test_123";
const env = (extra: Record<string, string> = {}) => ({ MEKO_API_KEY: KEY, ...extra });
const noWait = async () => {};

test("config: needs a well-formed key and https URLs, and never echoes the key", () => {
  assert.equal(mekoConfig(env()).mcpUrl.href, "https://mcp.mekodata.ai/mcp");
  assert.equal(mekoConfig(env()).apiUrl.href, "https://api.mekodata.ai/api/v1");
  assert.throws(() => mekoConfig({}), /MEKO_API_KEY is missing/);
  assert.throws(() => mekoConfig({ MEKO_API_KEY: "sk_wrong_secret" }), (e: Error) => /mko_tkn_/.test(e.message) && !e.message.includes("sk_wrong_secret"));
  assert.throws(() => mekoConfig(env({ MEKO_API_URL: "http://api.mekodata.ai/api/v1" })), /MEKO_API_URL must use https/);
  assert.throws(() => mekoConfig(env({ MEKO_MCP_URL: "not a url" })), /MEKO_MCP_URL isn't a valid URL/);
});

/** Throws the given errors in turn, then succeeds. */
const flaky = (failures: unknown[]) => {
  let n = 0;
  return async () => {
    if (n < failures.length) throw failures[n++];
    return "ok";
  };
};

test("retries follow the operation: reads retry, writes that could duplicate are never resent after an unknown outcome", async () => {
  const s503 = new MekoError("down", 503);
  const s429 = new MekoError("slow down", 429, 1000);
  const s400 = new MekoError("bad", 400);
  assert.equal(await withRetry("t", "read", flaky([s503, s503]), noWait), "ok");
  assert.equal(await withRetry("t", "write-once", flaky([s429]), noWait), "ok", "a 429 was refused, so resending is safe");
  await assert.rejects(withRetry("t", "write-once", flaky([s503]), noWait), UnknownOutcomeError);
  await assert.rejects(withRetry("t", "write-once", flaky([new TypeError("fetch failed")]), noWait), UnknownOutcomeError);
  await assert.rejects(withRetry("t", "write-once", flaky([new McpError(ErrorCode.InternalError, "boom")]), noWait), UnknownOutcomeError, "the server failed after taking the call");
  await assert.rejects(withRetry("t", "read", flaky([s400]), noWait), (e) => e === s400);
  await assert.rejects(withRetry("t", "read", flaky([s503, s503, s503]), noWait), (e) => e === s503, "gives up after 3 attempts");

  const waits: number[] = [];
  await withRetry("t", "idempotent", flaky([s429]), async (ms) => void waits.push(ms));
  assert.deepEqual(waits, [1000], "honors Retry-After");
  assert.equal(classify(new StreamableHTTPError(502, "bad gateway")), "transient");
  assert.equal(classify(new StreamableHTTPError(403, "forbidden")), "permanent");
  assert.equal(classify(new StreamableHTTPError(-1, "Unexpected content type: text/html")), "transient", "a success that can't be read");
  assert.equal(classify(new MekoError("refused: datapack_id_required")), "permanent", "the tool's own answer");
  assert.equal(classify(new Error("something else")), "transient", "only a clear refusal is permanent");

  const after = (value: string) => new Response(null, { status: 429, headers: { "Retry-After": value } });
  const now = Date.parse("Tue, 24 Nov 2026 10:00:00 GMT");
  assert.equal(retryAfterMs(after("120"), now), 120_000);
  assert.equal(retryAfterMs(after("Tue, 24 Nov 2026 10:01:30 GMT"), now), 90_000, "an HTTP date works too");
  assert.equal(retryAfterMs(after("soon"), now), undefined);
  const tooLong = new MekoError("slow down", 429, 120_000);
  waits.length = 0;
  await assert.rejects(withRetry("t", "read", flaky([tooLong]), async (ms) => void waits.push(ms)), (e) => e === tooLong);
  assert.deepEqual(waits, [], "a wait over a minute surfaces the 429 instead of retrying early");
});

test("REST: sends the key and User-Agent only to the API, unwraps { data }, turns { error } into a MekoError, retries per operation", async () => {
  const seen: { auth?: string; ua?: string; url?: string }[] = [];
  let flakyFailures = 1;
  const server = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, ua: req.headers["user-agent"], url: req.url });
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url?.startsWith("/api/v1/flaky") && flakyFailures-- > 0) return void json(503, {});
    if (req.url?.startsWith("/api/v1/bad")) return void json(400, { data: null, error: { code: "VALIDATION_ERROR", message: "name is required" } });
    if (req.url?.startsWith("/api/v1/html")) return void res.writeHead(403, { "Content-Type": "text/html" }).end("<html>Forbidden</html>");
    if (req.url?.startsWith("/api/v1/garbled")) return void res.writeHead(200, { "Content-Type": "text/html" }).end("<html>OK</html>");
    json(200, { data: { ok: true } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cfg = { ...mekoConfig(env()), apiUrl: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`) };
  const rest = restClient(cfg, { wait: noWait });
  try {
    assert.deepEqual(await rest.request("GET", "datapacks?limit=1", "read"), { ok: true });
    assert.deepEqual(seen[0], { auth: `Bearer ${KEY}`, ua: USER_AGENT, url: "/api/v1/datapacks?limit=1" });
    assert.deepEqual(await rest.request("GET", "flaky", "read"), { ok: true }, "a 503 on a read is retried");
    await assert.rejects(rest.request("POST", "bad", "idempotent", {}), (e: MekoError) => e.status === 400 && /name is required/.test(e.message));
    await assert.rejects(rest.request("GET", "html", "read"), (e: MekoError) => e.status === 403 && /Forbidden/.test(e.message));
    flakyFailures = 1;
    await assert.rejects(rest.request("POST", "flaky", "write-once", {}), UnknownOutcomeError);
    await assert.rejects(rest.request("POST", "garbled", "write-once", {}), UnknownOutcomeError, "a 200 that can't be read may have been applied");
    assert.equal(rest.calls.get("GET /datapacks"), 1);

    const sent = seen.length;
    for (const path of ["https://storage.example.com/upload?sig=secret", "///storage.example.com/upload", "../upload"]) {
      await assert.rejects(rest.request("POST", path, "write-once", {}), (e: Error) => /outside/.test(e.message) && !e.message.includes("secret"));
    }
    assert.equal(seen.length, sent, "nothing outside the API was sent, with or without the key");
  } finally {
    server.close();
  }
});

test("MCP: parses JSON answers, keeps plain text for reads, raises tool errors and in-band errors, needs a receipt for a write, counts calls by tool", async () => {
  const server = new McpServer({ name: "fake-meko", version: "1.0.0" });
  const receipt = { results: [{ id: "m1", memory: "x", event: "ADD" }] };
  // memory_add answers with these in turn: a real receipt, then three without a usable memory ID.
  const memoryAdds: unknown[] = [receipt, {}, { results: [] }, { results: [{ id: "" }] }];
  server.registerTool("memory_add", { description: "fake" }, async () => ({ content: [{ type: "text", text: JSON.stringify(memoryAdds.shift()) }] }));
  server.registerTool("add_truncated", { description: "fake" }, async () => ({ content: [{ type: "text", text: '{"results":[{"id":"m1","mem' }] }));
  server.registerTool("add_empty", { description: "fake" }, async () => ({ content: [] }));
  server.registerTool("plain", { description: "fake" }, async () => ({ content: [{ type: "text", text: "not json" }] }));
  server.registerTool("broken", { description: "fake" }, async () => ({ content: [{ type: "text", text: "datapack not found" }], isError: true }));
  server.registerTool("refused", { description: "fake" }, async () => ({ content: [{ type: "text", text: JSON.stringify({ error: "datapack_id_required" }) }] }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = await mcpOver(clientSide, noWait);
  try {
    assert.deepEqual(await mcp.call("memory_add", { text: "x" }, "write-once"), receipt);
    for (const answer of ["{}", "no results", "an empty ID"]) {
      await assert.rejects(mcp.call("memory_add", { text: "x" }, "write-once"), UnknownOutcomeError, `memory_add answering ${answer}`);
    }
    assert.equal(mcp.calls.get("memory_add"), 4, "one attempt each: a write without its memory ID is never resent");
    assert.equal(await mcp.call("plain", {}, "read"), "not json");
    await assert.rejects(mcp.call("broken", {}, "read"), /broken: datapack not found/);
    await assert.rejects(mcp.call("refused", {}, "write-once"), (e: MekoError) => e.message === "refused: datapack_id_required" && !(e instanceof UnknownOutcomeError));
    for (const tool of ["add_truncated", "add_empty"]) {
      await assert.rejects(mcp.call(tool, {}, "write-once"), UnknownOutcomeError, `${tool}: a write without a readable receipt`);
      assert.equal(mcp.calls.get(tool), 1, "never resent");
    }
    assert.deepEqual((await mcp.tools()).map((t) => t.name).sort(), ["add_empty", "add_truncated", "broken", "memory_add", "plain", "refused"]);
  } finally {
    await mcp.close();
  }
});

type Reply = { status: number; headers?: Record<string, string>; body?: string };
const rpc = (id: number, result: unknown): Reply => ({ status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, result }) });

/** A Streamable HTTP endpoint just big enough for the SDK client: it initializes, then each tool call takes the next reply. */
async function httpMcp(replies: ((id: number) => Reply)[]) {
  const auth = new Set<string | undefined>();
  const server = createServer(async (req, res) => {
    auth.add(req.headers.authorization);
    if (req.method !== "POST") return void res.writeHead(405).end(); // no standalone event stream
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { id, method, params } = JSON.parse(raw);
    if (id === undefined) return void res.writeHead(202).end(); // a notification
    const hello = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-meko", version: "1.0.0" } };
    const reply = method === "initialize" ? rpc(id, hello) : replies.shift()!(id);
    res.writeHead(reply.status, reply.headers).end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), auth, close: () => server.close() };
}

test("MCP over HTTP: sends the key, waits as long as a 429 asks, and treats an unreadable success on a write as an unknown outcome", async () => {
  const limited = (): Reply => ({ status: 429, headers: { "Retry-After": "60" } });
  const results = (id: number) => rpc(id, { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] });
  const html = (): Reply => ({ status: 200, headers: { "Content-Type": "text/html" }, body: "<html>maintenance</html>" });
  const fake = await httpMcp([limited, limited, results, html]);
  const waits: number[] = [];
  const mcp = await connectMcp({ ...mekoConfig(env()), mcpUrl: fake.url }, async (ms) => void waits.push(ms));
  try {
    assert.deepEqual(await mcp.call("memory_search", { query: "x" }, "read"), { results: [] });
    assert.deepEqual(waits, [60_000, 60_000], "the SDK drops Retry-After, so the client reads it first");
    await assert.rejects(mcp.call("memory_add", { text: "x" }, "write-once"), UnknownOutcomeError);
    assert.equal(mcp.calls.get("memory_add"), 1, "never resent");
    assert.deepEqual([...fake.auth], [`Bearer ${KEY}`]);
  } finally {
    await mcp.close();
    fake.close();
  }
});
