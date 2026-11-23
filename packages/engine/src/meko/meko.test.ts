import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mekoConfig, USER_AGENT } from "../config.js";
import { mcpOver } from "./mcp.js";
import { restClient } from "./rest.js";
import { classify, MekoError, UnknownOutcomeError, withRetry } from "./retry.js";

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
  await assert.rejects(withRetry("t", "read", flaky([s400]), noWait), (e) => e === s400);
  await assert.rejects(withRetry("t", "read", flaky([s503, s503, s503]), noWait), (e) => e === s503, "gives up after 3 attempts");

  const waits: number[] = [];
  await withRetry("t", "idempotent", flaky([s429]), async (ms) => void waits.push(ms));
  assert.deepEqual(waits, [1000], "honors Retry-After");
  assert.equal(classify(new StreamableHTTPError(502, "bad gateway")), "transient");
  assert.equal(classify(new StreamableHTTPError(403, "forbidden")), "permanent");
  assert.equal(classify(new Error("something else")), "permanent");
});

test("REST: sends the key and User-Agent, unwraps { data }, turns { error } into a MekoError, retries per operation", async () => {
  const seen: { auth?: string; ua?: string; url?: string }[] = [];
  let flakyFailures = 1;
  const server = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, ua: req.headers["user-agent"], url: req.url });
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url?.startsWith("/api/v1/flaky") && flakyFailures-- > 0) return void json(503, {});
    if (req.url?.startsWith("/api/v1/bad")) return void json(400, { data: null, error: { code: "VALIDATION_ERROR", message: "name is required" } });
    if (req.url?.startsWith("/api/v1/html")) return void res.writeHead(403, { "Content-Type": "text/html" }).end("<html>Forbidden</html>");
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
    assert.equal(rest.calls.get("GET /datapacks"), 1);
  } finally {
    server.close();
  }
});

test("MCP: parses JSON answers, keeps plain text, raises tool errors and in-band errors, counts calls by tool", async () => {
  const server = new McpServer({ name: "fake-meko", version: "1.0.0" });
  server.registerTool("memory_add", { description: "fake" }, async () => ({ content: [{ type: "text", text: JSON.stringify({ id: "m1" }) }] }));
  server.registerTool("plain", { description: "fake" }, async () => ({ content: [{ type: "text", text: "not json" }] }));
  server.registerTool("broken", { description: "fake" }, async () => ({ content: [{ type: "text", text: "datapack not found" }], isError: true }));
  server.registerTool("refused", { description: "fake" }, async () => ({ content: [{ type: "text", text: JSON.stringify({ error: "datapack_id_required" }) }] }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = await mcpOver(clientSide, noWait);
  try {
    assert.deepEqual(await mcp.call("memory_add", { text: "x" }, "write-once"), { id: "m1" });
    assert.equal(await mcp.call("plain", {}, "read"), "not json");
    await assert.rejects(mcp.call("broken", {}, "read"), /broken: datapack not found/);
    await assert.rejects(mcp.call("refused", {}, "write-once"), (e: MekoError) => e.message === "refused: datapack_id_required" && !(e instanceof UnknownOutcomeError));
    assert.deepEqual((await mcp.tools()).map((t) => t.name).sort(), ["broken", "memory_add", "plain", "refused"]);
    assert.equal(mcp.calls.get("memory_add"), 1);
  } finally {
    await mcp.close();
  }
});
