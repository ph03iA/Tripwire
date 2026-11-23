import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * How a call may be retried (engineering spec §6):
 * - `read`: searches, gets, lists, status
 * - `idempotent`: writes that are safe to repeat (artifact_put by content hash, datapack create, conversation writes
 *   with a `seed` or `session_id`)
 * - `write-once`: writes that could duplicate if resent (memory_add, promotion). They retry only when Meko refused
 *   them (429); after anything short of a clear refusal the outcome is unknown.
 */
export type Op = "read" | "idempotent" | "write-once";

export class MekoError extends Error {
  override name = "MekoError";
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** The write may or may not have been applied. Never resend it: reconcile it, or fail the run. */
export class UnknownOutcomeError extends MekoError {
  override name = "UnknownOutcomeError";
  constructor(what: string, cause: unknown) {
    super(`${what}: outcome unknown, not resent (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}

export type Failure = "rate-limited" | "transient" | "permanent";
export type Wait = (ms: number) => Promise<void>;

const ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
const TRANSIENT_MCP = new Set<number>([ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed]);
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `attempt`, retrying per the operation's policy with exponential backoff and Retry-After. */
export async function withRetry<T>(what: string, op: Op, attempt: () => Promise<T>, wait: Wait = sleep): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      const failure = classify(err);
      if (failure === "transient" && op === "write-once") throw new UnknownOutcomeError(what, err);
      if (failure === "permanent" || tries >= ATTEMPTS) throw err;
      await wait(delayMs(tries, err));
    }
  }
}

/**
 * `permanent` only when Meko clearly refused: a 4xx other than 429, a JSON-RPC error, or a tool that answered with an
 * error. Anything else (a 5xx, a timeout, a dropped connection, a success that can't be read) may have been applied.
 */
export function classify(err: unknown): Failure {
  const status = statusOf(err);
  if (status === 429) return "rate-limited";
  if (status !== undefined) return status >= 400 && status < 500 ? "permanent" : "transient";
  if (err instanceof McpError) return TRANSIENT_MCP.has(err.code) ? "transient" : "permanent";
  return err instanceof MekoError ? "permanent" : "transient"; // a MekoError without a status is the tool's own answer
}

/** The HTTP status behind an error, if any: the SDK's StreamableHTTPError calls it `code` (-1 for an unreadable answer). */
const statusOf = (err: unknown) => (err instanceof MekoError ? err.status : err instanceof StreamableHTTPError ? err.code : undefined);

/** The wait a response asks for in its Retry-After header (seconds), if any. */
export function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return seconds > 0 ? seconds * 1000 : undefined;
}

/** Retry-After when Meko sent one (capped at a minute), else 0.5 s, 1 s, 2 s… with jitter. */
function delayMs(tries: number, err: unknown): number {
  if (err instanceof MekoError && err.retryAfterMs) return Math.min(err.retryAfterMs, MAX_WAIT_MS);
  return Math.min(500 * 2 ** (tries - 1), 4000) + Math.floor(Math.random() * 250);
}
