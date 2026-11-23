import type { MekoConfig } from "../config.js";
import { MekoError, type Op, type Wait, withRetry } from "./retry.js";

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
    request: (method, path, op, body) => {
      const what = `${method} /${path.replace(/^\//, "").split(/[/?]/)[0]}`;
      return withRetry(what, op, async () => {
        calls.set(what, (calls.get(what) ?? 0) + 1);
        const res = await send(new URL(path.replace(/^\//, ""), base), {
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return seconds > 0 ? seconds * 1000 : undefined;
}
