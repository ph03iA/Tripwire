import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MekoConfig } from "../config.js";
import { MekoError, type Op, retryAfterMs, type Wait, withRetry } from "./retry.js";

const TIMEOUT_MS = 10_000;

export type Mcp = {
  /** Calls a Meko MCP tool and returns its answer, parsed from JSON when it is JSON. Callers check the shape. */
  call(tool: string, args: Record<string, unknown>, op: Op): Promise<unknown>;
  tools(): Promise<Tool[]>;
  close(): Promise<void>;
  /** Attempts by tool, for the quota ledger. */
  calls: Map<string, number>;
};

export function connectMcp(cfg: MekoConfig, wait?: Wait): Promise<Mcp> {
  const headers = { Authorization: `Bearer ${cfg.apiKey}`, "User-Agent": cfg.userAgent };
  return mcpOver(new StreamableHTTPClientTransport(cfg.mcpUrl, { requestInit: { headers }, fetch: raiseRateLimit }), wait);
}

/** The SDK drops a 429's headers, so the 429 is raised here, before the SDK sees it, with the wait Meko asked for. */
async function raiseRateLimit(url: string | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;
  await res.body?.cancel();
  throw new MekoError("Meko MCP: rate limited (HTTP 429)", 429, retryAfterMs(res));
}

/** The client over any transport; tests use an in-memory one. */
export async function mcpOver(transport: Transport, wait?: Wait): Promise<Mcp> {
  const client = new Client({ name: "tripwire", version: "0.1.0" });
  await client.connect(transport, { timeout: TIMEOUT_MS });
  const calls = new Map<string, number>();
  return {
    calls,
    call: (tool, args, op) =>
      withRetry(tool, op, async () => {
        calls.set(tool, (calls.get(tool) ?? 0) + 1);
        return answerOf(tool, op, await client.callTool({ name: tool, arguments: args }, undefined, { timeout: TIMEOUT_MS }));
      }, wait),
    // shortcut: first page only; follow nextCursor if Meko ever pages its tool list.
    tools: async () => (await client.listTools(undefined, { timeout: TIMEOUT_MS })).tools,
    close: () => client.close(),
  };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

/**
 * Meko's tools answer with a JSON string (structuredContent only wraps the same string as `{ result }`), so the text
 * is parsed when it is JSON. A tool error, or an answer carrying `error` (e.g. `datapack_id_required`), throws. So does
 * a `write-once` answer without its receipt: then the write may or may not have happened.
 */
function answerOf(tool: string, op: Op, result: ToolResult): unknown {
  const text = textOf(result);
  if (result.isError) throw new MekoError(`${tool}: ${text || "tool error"}`);
  const json = parseJson(text);
  const answer = json ?? result.structuredContent ?? text;
  if (hasError(answer)) throw new MekoError(`${tool}: ${typeof answer.error === "string" ? answer.error : JSON.stringify(answer.error)}`);
  // Not a MekoError, so the retry policy treats it as an unknown outcome, not a refusal.
  if (op === "write-once" && !hasReceipt(tool, json)) throw new Error(`${tool}: no receipt in the answer (${text.length} characters of text)`);
  return answer;
}

/** The receipt a write must answer with to count as done; any other write needs at least a JSON object. */
const hasReceipt = (tool: string, json: unknown) => (RECEIPTS[tool] ?? isObject)(json);
const RECEIPTS: Record<string, (json: unknown) => boolean> = {
  // { results: [{ id, memory, event: "ADD" }] } (K1): without the ID, the signal can't be confirmed or trusted (R8).
  memory_add: (json) => {
    const id = isObject(json) && "results" in json && Array.isArray(json.results) ? json.results[0]?.id : undefined;
    return typeof id === "string" && id !== "";
  },
};

const textOf = (result: ToolResult) =>
  Array.isArray(result.content)
    ? result.content.flatMap((c: { type?: string; text?: string }) => (c.type === "text" && c.text ? [c.text] : [])).join("\n")
    : "";
const isObject = (x: unknown): x is object => typeof x === "object" && x !== null;
const hasError = (x: unknown): x is { error: unknown } => isObject(x) && "error" in x && x.error != null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
