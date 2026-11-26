import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lockDatapack } from "./lock.js";

test("one live ON run per signals datapack: a second one is refused until the first releases (review finding 1)", () => {
  // Regression: run B's start-of-run reset erased run A's signals while A was still running.
  const dir = mkdtempSync(join(tmpdir(), "tripwire-lock-"));
  const release = lockDatapack("dp1", "seed 42", dir);
  assert.throws(() => lockDatapack("dp1", "seed 7", dir), /another ON run \(seed 42, pid \d+/);
  assert.doesNotThrow(() => lockDatapack("dp2", "seed 7", dir)(), "another datapack isn't blocked");
  release();
  assert.ok(!existsSync(join(dir, "tripwire-on-dp1.lock")));
  lockDatapack("dp1", "seed 7", dir)();

  writeFileSync(join(dir, "tripwire-on-dp1.lock"), JSON.stringify({ pid: 2_147_483_646, label: "crashed", since: "2026-11-26T00:00:00Z" }));
  const takeover = lockDatapack("dp1", "seed 42", dir); // a crashed run's lock doesn't block forever
  takeover();
});
