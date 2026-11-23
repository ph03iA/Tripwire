import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MekoConfig } from "../config.js";
import { MekoError, type Op, type Wait, withRetry } from "./retry.js";

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
  return mcpOver(new StreamableHTTPClientTransport(cfg.mcpUrl, { requestInit: { headers } }), wait);
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
        return answerOf(tool, await client.callTool({ name: tool, arguments: args }, undefined, { timeout: TIMEOUT_MS }));
      }, wait),
    // shortcut: first page only; follow nextCursor if Meko ever pages its tool list.
    tools: async () => (await client.listTools(undefined, { timeout: TIMEOUT_MS })).tools,
    close: () => client.close(),
  };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

/**
 * Meko's tools answer with a JSON string (structuredContent only wraps the same string as `{ result }`), so the text
 * is parsed when it is JSON. A tool error, or an answer carrying `error` (e.g. `datapack_id_required`), throws.
 */
function answerOf(tool: string, result: ToolResult): unknown {
  const text = Array.isArray(result.content)
    ? result.content.flatMap((c: { type?: string; text?: string }) => (c.type === "text" && c.text ? [c.text] : [])).join("\n")
    : "";
  if (result.isError) throw new MekoError(`${tool}: ${text || "tool error"}`);
  const answer = parseJson(text) ?? result.structuredContent ?? text;
  if (hasError(answer)) throw new MekoError(`${tool}: ${typeof answer.error === "string" ? answer.error : JSON.stringify(answer.error)}`);
  return answer;
}

const hasError = (x: unknown): x is { error: unknown } => typeof x === "object" && x !== null && "error" in x && x.error != null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
