import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { mekoConfig } from "../config.js";
import { findDatapack, restClient } from "../meko/rest.js";
import { knowledgeFiles, uploadFile } from "./upload.js";

const noWait = async () => {};
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
const CURRENT = "u/dp1/h/policy.md"; // the upload ticket's key: the copy of the bytes being uploaded

/**
 * Meko's API and storage as the upload sees them, logging every call in one order. The knowledge base holds an older
 * copy of policy.md and an unrelated policy.md.bak; the live API names documents by their storage key.
 */
function fakeMeko({ alreadyUploaded = false, finalState = "completed", storageStatus = 204 } = {}) {
  const calls: string[] = [];
  const docs = new Map([["doc_old", "u/dp1/0ld/policy.md"], ["doc_bak", "u/dp1/0ld/policy.md.bak"]]);
  const api: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mko_tkn_test", "every API call carries the key");
    const call = `${init?.method} ${url.pathname.replace("/api/v1/datapacks/dp1/knowledge-bases", "")}`;
    calls.push(call);
    if (call === "POST /upload-url") {
      if (!alreadyUploaded) return ok({ url: "https://bucket.example/", key: CURRENT, already_uploaded: false, fields: { key: CURRENT, policy: "p", "x-amz-signature": "s" } });
      docs.set("doc_current", CURRENT);
      return ok({ url: "", key: CURRENT, already_uploaded: true });
    }
    if (call === "GET /documents") return ok({ items: [...docs].map(([id, document_name]) => ({ id, document_name })), has_more: false });
    if (call.startsWith("DELETE /documents/")) return docs.delete(call.split("/").pop()!), ok({});
    if (call === "GET /document-status") return ok({ state: calls.filter((c) => c === call).length < 2 ? "indexing" : finalState });
    if (call === "GET /api/v1/datapacks") return ok({ items: [{ datapack_id: "dp1", datapack_name: url.searchParams.get("name") }] });
    return new Response(JSON.stringify({ data: null, error: { message: "unexpected" } }), { status: 400 });
  };
  const stored: { auth: string | null; fields: string[]; size: number }[] = [];
  const storage: typeof fetch = async (_input, init) => {
    const form = init!.body as FormData;
    calls.push(`storage POST → ${storageStatus}`);
    stored.push({ auth: new Headers(init?.headers).get("authorization"), fields: [...form.keys()], size: (form.get("file") as Blob).size });
    if (storageStatus === 204) docs.set("doc_current", CURRENT);
    return new Response(null, { status: storageStatus });
  };
  const upload = () => uploadFile(restClient(mekoConfig({ MEKO_API_KEY: "mko_tkn_test" }), { fetch: api, wait: noWait }), "dp1", file, { storage, wait: noWait });
  return { upload, calls, stored, docs: () => [...docs.keys()].sort() };
}

const dir = mkdtempSync(join(tmpdir(), "tripwire-kb-"));
const file = join(dir, "policy.md");
const text = "# Step-up policy\n\nBLOCK at 0.8 or more: ₹ amounts are multi-byte.\n";
writeFileSync(file, text);

test("upload: new bytes are stored and indexed before the older copy is deleted, and storage never gets the key", async () => {
  const meko = fakeMeko();
  assert.deepEqual(await meko.upload(), { outcome: "uploaded", olderDeleted: 1 });
  assert.deepEqual(meko.calls, ["POST /upload-url", "storage POST → 204", "GET /document-status", "GET /document-status", "GET /documents",
    "DELETE /documents/doc_old"]);
  assert.deepEqual(meko.stored, [{ auth: null, fields: ["key", "policy", "x-amz-signature", "file"], size: Buffer.byteLength(text) }],
    "the fields, then the exact bytes");
  assert.deepEqual(meko.docs(), ["doc_bak", "doc_current"], "policy.md.bak isn't a copy of policy.md");
});

test("upload: when storage fails, the older copy stays searchable (review finding 4)", async () => {
  // Regression: the older copy used to be deleted first, so a failed upload left the knowledge base without the file.
  const meko = fakeMeko({ storageStatus: 500 });
  await assert.rejects(meko.upload(), /storage answered HTTP 500/);
  assert.deepEqual(meko.calls, ["POST /upload-url", "storage POST → 500"]);
  assert.deepEqual(meko.docs(), ["doc_bak", "doc_old"]);
});

test("upload: the same bytes aren't sent again, and a re-run deletes an older copy an earlier run left", async () => {
  const meko = fakeMeko({ alreadyUploaded: true });
  assert.deepEqual(await meko.upload(), { outcome: "unchanged", olderDeleted: 1 });
  assert.deepEqual(meko.stored, [], "nothing is sent to storage");
  assert.deepEqual(meko.docs(), ["doc_bak", "doc_current"]);
});

test("upload: indexing that fails is an error, and nothing is deleted", async () => {
  const meko = fakeMeko({ finalState: "failed" });
  await assert.rejects(meko.upload(), /policy.md: indexing failed/);
  assert.ok(!meko.calls.some((c) => c.startsWith("DELETE")));
});

test("the knowledge docs are found by exact name, and every doc name is unique", async () => {
  const rest = restClient(mekoConfig({ MEKO_API_KEY: "mko_tkn_test" }), {
    fetch: async (input) => ok({ items: [{ datapack_id: "dp1", datapack_name: new URL(String(input)).searchParams.get("name") }] }), wait: noWait });
  assert.equal(await findDatapack(rest, "tripwire-patterns"), "dp1");
  const names = knowledgeFiles().map((f) => basename(f));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("step-up-policy.md") && names.includes("risk-rules.md") && names.includes("support-desk-takeover.md"), names.join(", "));
});
