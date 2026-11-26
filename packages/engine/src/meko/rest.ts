import type { MekoConfig } from "../config.js";
import { MekoError, type Op, retryAfterMs, type Wait, withRetry } from "./retry.js";

const TIMEOUT_MS = 10_000;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Envelope = { data?: unknown; error?: { code?: string; message?: string } | null };

export type Rest = {
  /** Calls the Meko REST API and returns its `data`. Callers check the shape before using it. */
  request<T>(method: Method, path: string, op: Op, body?: unknown): Promise<T>;
  /** Attempts by "METHOD /resource", for the quota ledger. */
  calls: Map<string, number>;
};

export function restClient(cfg: MekoConfig, { fetch: send = fetch, wait }: { fetch?: typeof fetch; wait?: Wait } = {}): Rest {
  const base = cfg.apiUrl.href.endsWith("/") ? cfg.apiUrl.href : `${cfg.apiUrl.href}/`;
  const headers = { Authorization: `Bearer ${cfg.apiKey}`, "User-Agent": cfg.userAgent, Accept: "application/json" };
  const calls = new Map<string, number>();
  return {
    calls,
    request: async (method, path, op, body) => {
      const url = new URL(path.replace(/^\//, ""), base);
      // The key goes only to Meko's API: a URL outside it (a signed storage URL, say) needs its own request without it.
      if (!url.href.startsWith(base)) throw new Error(`${method} ${url.origin}: outside ${base}, so it isn't sent with the Meko key`);
      const what = `${method} /${path.replace(/^\//, "").split(/[/?]/)[0]}`;
      return withRetry(what, op, async () => {
        calls.set(what, (calls.get(what) ?? 0) + 1);
        const res = await send(url, {
          method,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return unwrap(res, what);
      }, wait);
    },
  };
}

/** Meko answers `{ data, error }`. Anything else, or any error, becomes a MekoError: never a guess. */
async function unwrap<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  const json = parseJson(text);
  if (res.ok && isEnvelope(json) && !json.error) return json.data as T;
  const message = isEnvelope(json) && json.error?.message ? json.error.message : `HTTP ${res.status}: ${text.slice(0, 120)}`;
  throw new MekoError(`${what}: ${message}`, res.status, retryAfterMs(res));
}

const isEnvelope = (x: unknown): x is Envelope => typeof x === "object" && x !== null && ("data" in x || "error" in x);

/**
 * A datapack's ID, by its exact name (names are unique per account). Never creates one: the Free plan allows 10 ever,
 * so a new datapack is made by hand, with the owner's OK. The answer names the owner, so it's never echoed.
 */
export async function findDatapack(rest: Rest, name: string): Promise<string> {
  const page = await rest.request<{ items?: unknown }>("GET", `datapacks?name=${encodeURIComponent(name)}&limit=1`, "read");
  if (!Array.isArray(page?.items)) throw new Error("GET /datapacks: unexpected answer");
  const id = (page.items as { datapack_id?: unknown; datapack_name?: unknown }[]).find((d) => d?.datapack_name === name)?.datapack_id;
  if (typeof id !== "string") throw new Error(`the ${name} datapack doesn't exist: create it by hand, since each one uses one of the 10 lifetime slots`);
  return id;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
