import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "../config.js";
import type { Rest } from "../meko/rest.js";
import { MekoError, type Wait } from "../meko/retry.js";

export const KNOWLEDGE_DIR = fileURLToPath(new URL("../../../../knowledge/", import.meta.url));
export const PATTERNS_DATAPACK = "tripwire-patterns";
export const POLICY_FILE = "step-up-policy.md";
const POLL_MS = 2000;
const POLLS = 60; // 2 minutes
const STOPPED = new Set(["failed", "abandoned", "oversized"]);

/** The docs the decision agent quotes (PRD C2): knowledge/*.md and the playbooks. Their names are unique, so a file's name is its document name. */
// shortcut: a renamed or removed doc stays in the knowledge base; delete it in the portal, or here once docs start moving around.
export function knowledgeFiles(dir = KNOWLEDGE_DIR): string[] {
  return [dir, join(dir, "playbooks")].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".md")).sort().map((f) => join(d, f)));
}

/** The fraud playbooks: the only documents a decision may quote as its playbook passage (PRD C3). */
export const playbookFiles = (dir = KNOWLEDGE_DIR) => knowledgeFiles(dir).filter((f) => basename(dirname(f)) === "playbooks");

/**
 * The uploaded policy's and playbooks' document IDs, so an ON run can check that each quote comes from the right
 * document. A missing one stops the run before it starts: quotes need every document uploaded.
 */
export async function knowledgeDocuments(rest: Rest, datapackId: string): Promise<{ policy: string; playbooks: string[] }> {
  const ids = new Map<string, string>(); // file name → document ID; the live API names a document by its storage key
  for (let page = 1; ; page++) {
    const list = await rest.request<{ items?: unknown; has_more?: unknown }>("GET",
      `datapacks/${datapackId}/knowledge-bases/documents?page=${page}&page_size=200`, "read");
    if (!Array.isArray(list?.items)) throw new Error("GET /documents: unexpected answer");
    for (const d of list.items as Doc[]) if (typeof d?.document_name === "string" && typeof d.id === "string") ids.set(d.document_name.split("/").pop()!, d.id);
    if (list.has_more !== true) break;
  }
  const idOf = (file: string) => {
    const id = ids.get(file);
    if (!id) throw new Error(`${file} isn't in the ${PATTERNS_DATAPACK} knowledge base: run npm run upload-knowledge first`);
    return id;
  };
  return { policy: idOf(POLICY_FILE), playbooks: playbookFiles().map((f) => idOf(basename(f))) };
}

type Ticket = { url: string; key: string; already_uploaded: boolean; fields?: Record<string, string> };
type Doc = { id: string; document_name: string };
type Deps = { storage?: typeof fetch; wait?: Wait };
export type Uploaded = { outcome: "unchanged" | "uploaded"; olderDeleted: number };

/**
 * Uploads one file to a datapack's knowledge base, unless those exact bytes are already there (Meko keys files by
 * SHA-256), and waits until it's indexed. Only then are the file's older copies deleted, so a failed upload leaves the
 * last good version searchable, and a re-run finishes a cleanup that an earlier run didn't get to.
 */
export async function uploadFile(rest: Rest, datapackId: string, path: string, { storage = fetch, wait = sleep }: Deps = {}): Promise<Uploaded> {
  const bytes = readFileSync(path);
  const filename = basename(path);
  const kb = `datapacks/${datapackId}/knowledge-bases`;
  const ticket = await rest.request<unknown>("POST", `${kb}/upload-url`, "idempotent",
    { filename, size: bytes.length, content_hash: createHash("sha256").update(bytes).digest("hex"), client: USER_AGENT });
  if (!isTicket(ticket)) throw new Error(`${filename}: unexpected answer to the upload-url request`);
  if (!ticket.already_uploaded) await sendToStorage(ticket, bytes, filename, storage);
  await untilIndexed(rest, `${kb}/document-status?document_key=${encodeURIComponent(ticket.key)}`, filename, wait);
  const older = await olderCopies(rest, kb, filename, ticket.key);
  for (const doc of older) await deleteDocument(rest, `${kb}/documents/${doc.id}`);
  return { outcome: ticket.already_uploaded ? "unchanged" : "uploaded", olderDeleted: older.length };
}

/**
 * The file's other copies. The live API names a document by its storage key, `<owner>/<datapack>/<sha256>/<name>`
 * (2026-11-26), and the ticket's key is the current copy's, so any other key ending in `/<name>` is an older version.
 * `q` matches any part of a name, so `policy.md.bak` comes back for `policy.md` and is left out here.
 */
// shortcut: a document named only `<name>`, as Meko's docs show, can't be told from the current copy, so it's left alone.
async function olderCopies(rest: Rest, kb: string, filename: string, currentKey: string): Promise<Doc[]> {
  const docs: Doc[] = [];
  const isOlder = (name: unknown) => typeof name === "string" && name.endsWith(`/${filename}`) && name !== currentKey;
  for (let page = 1; ; page++) {
    const list = await rest.request<{ items?: unknown; has_more?: unknown }>("GET",
      `${kb}/documents?q=${encodeURIComponent(filename)}&page=${page}&page_size=200`, "read");
    if (!Array.isArray(list?.items)) throw new Error("GET /documents: unexpected answer");
    docs.push(...(list.items as Doc[]).filter((d) => isOlder(d?.document_name) && typeof d.id === "string"));
    if (list.has_more !== true) return docs;
  }
}

/** A 404 means it's gone already: a retried delete whose first answer was lost. */
async function deleteDocument(rest: Rest, path: string) {
  await rest.request("DELETE", path, "idempotent").catch((err: unknown) => {
    if (!(err instanceof MekoError && err.status === 404)) throw err;
  });
}

/** Storage takes the ticket's form fields, then the file last. It never gets the Meko key: that goes only to Meko's API. */
async function sendToStorage(ticket: Ticket, bytes: Uint8Array, filename: string, storage: typeof fetch) {
  const url = new URL(ticket.url);
  if (url.protocol !== "https:") throw new Error(`${filename}: the storage URL isn't https`);
  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.fields ?? {})) form.append(name, value);
  form.append("file", new Blob([new Uint8Array(bytes)]), filename);
  const res = await storage(url, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${filename}: storage answered HTTP ${res.status}; run the upload again`);
}

async function untilIndexed(rest: Rest, statusPath: string, filename: string, wait: Wait) {
  for (let poll = 1; poll <= POLLS; poll++) {
    const state = await stateOf(rest, statusPath);
    if (state === "completed") return;
    if (STOPPED.has(state)) throw new Error(`${filename}: indexing ${state}; delete it in the portal and run the upload again`);
    await wait(POLL_MS);
  }
  throw new Error(`${filename}: not indexed after ${(POLLS * POLL_MS) / 1000} s; run the upload again later`);
}

/** A 404 while storage hands the file to Meko means it isn't registered yet (Meko's docs), so it's polled again. */
async function stateOf(rest: Rest, statusPath: string): Promise<string> {
  try {
    const status = await rest.request<{ state?: unknown }>("GET", statusPath, "read");
    if (typeof status?.state !== "string") throw new Error("GET /document-status: unexpected answer");
    return status.state;
  } catch (err) {
    if (err instanceof MekoError && err.status === 404) return "awaiting_upload";
    throw err;
  }
}

const isTicket = (x: unknown): x is Ticket =>
  typeof x === "object" && x !== null && "already_uploaded" in x && typeof x.already_uploaded === "boolean"
  && "key" in x && typeof x.key === "string" && "url" in x && typeof x.url === "string";
