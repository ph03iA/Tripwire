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

/** Meko's API as the upload sees it: one older document named policy.md, and indexing that ends in `finalState`. */
function fakeMeko(alreadyUploaded: boolean, finalState = "completed") {
  const calls: string[] = [];
  const api: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mko_tkn_test", "every API call carries the key");
    const call = `${init?.method} ${url.pathname.replace("/api/v1/datapacks/dp1/knowledge-bases", "")}`;
    calls.push(call);
    if (call === "POST /upload-url") {
      return ok(alreadyUploaded ? { url: "", key: "u/dp1/h/policy.md", already_uploaded: true }
        : { url: "https://bucket.example/", key: "u/dp1/h/policy.md", already_uploaded: false, fields: { key: "u/dp1/h/policy.md", policy: "p", "x-amz-signature": "s" } });
    }
    if (call === "GET /documents") return ok({ items: [{ id: "doc_old", document_name: "policy.md" }, { id: "doc_bak", document_name: "policy.md.bak" }], has_more: false });
    if (call.startsWith("DELETE /documents/")) return ok({ document_id: call.split("/").pop() });
    if (call === "GET /document-status") return ok({ state: calls.filter((c) => c === call).length < 2 ? "indexing" : finalState });
    if (call === "GET /api/v1/datapacks") return ok({ items: [{ datapack_id: "dp1", datapack_name: url.searchParams.get("name") }] });
    return new Response(JSON.stringify({ data: null, error: { message: "unexpected" } }), { status: 400 });
  };
  const stored: { auth: string | null; fields: string[]; size: number }[] = [];
  const storage: typeof fetch = async (_input, init) => {
    const form = init!.body as FormData;
    stored.push({ auth: new Headers(init?.headers).get("authorization"), fields: [...form.keys()], size: (form.get("file") as Blob).size });
    return new Response(null, { status: 204 });
  };
  return { rest: restClient(mekoConfig({ MEKO_API_KEY: "mko_tkn_test" }), { fetch: api, wait: noWait }), calls, stored, storage };
}

const dir = mkdtempSync(join(tmpdir(), "tripwire-kb-"));
const file = join(dir, "policy.md");
const text = "# Step-up policy\n\nBLOCK at 0.8 or more: ₹ amounts are multi-byte.\n";
writeFileSync(file, text);

test("upload: the same bytes are left alone; it still waits until they're indexed", async () => {
  const meko = fakeMeko(true);
  assert.equal(await uploadFile(meko.rest, "dp1", file, { storage: meko.storage, wait: noWait }), "unchanged");
  assert.deepEqual(meko.calls, ["POST /upload-url", "GET /document-status", "GET /document-status"]);
  assert.deepEqual(meko.stored, [], "nothing is sent to storage");
});

test("upload: new bytes replace the older document of the same name, and storage never gets the key", async () => {
  const meko = fakeMeko(false);
  assert.equal(await uploadFile(meko.rest, "dp1", file, { storage: meko.storage, wait: noWait }), "uploaded");
  assert.deepEqual(meko.calls, ["POST /upload-url", "GET /documents", "DELETE /documents/doc_old", "GET /document-status", "GET /document-status"]);
  assert.deepEqual(meko.stored, [{ auth: null, fields: ["key", "policy", "x-amz-signature", "file"], size: Buffer.byteLength(text) }],
    "the fields, then the exact bytes");
});

test("upload: indexing that fails is an error, not a success", async () => {
  const meko = fakeMeko(false, "failed");
  await assert.rejects(uploadFile(meko.rest, "dp1", file, { storage: meko.storage, wait: noWait }), /policy.md: indexing failed/);
});

test("the knowledge docs are found by exact name, and every doc name is unique", async () => {
  assert.equal(await findDatapack(fakeMeko(true).rest, "tripwire-patterns"), "dp1");
  const names = knowledgeFiles().map((f) => basename(f));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("step-up-policy.md") && names.includes("risk-rules.md") && names.includes("support-desk-takeover.md"), names.join(", "));
});
