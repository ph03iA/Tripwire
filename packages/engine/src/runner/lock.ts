import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Holder = { pid: number; label: string; since: string };

/**
 * One live ON run at a time per signals datapack on this machine. Each run starts by emptying the datapack (R5), so a
 * second run would erase the first one's signals. A run on another machine isn't seen here; the R8 audit still fails a
 * run whose own signals are gone. Returns the release.
 */
export function lockDatapack(datapackId: string, label: string, dir = tmpdir()): () => void {
  const file = join(dir, `tripwire-on-${datapackId}.lock`);
  const mine = JSON.stringify({ pid: process.pid, label, since: new Date().toISOString() } satisfies Holder);
  try {
    writeFileSync(file, mine, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const held = holderOf(file);
    if (held && isRunning(held.pid)) {
      throw new Error(`another ON run (${held.label}, pid ${held.pid}, since ${held.since}) is using this signals datapack: one run at a time`,
        { cause: err });
    }
    writeFileSync(file, mine); // left by a run that crashed: take it over
  }
  return () => rmSync(file, { force: true });
}

function holderOf(file: string): Holder | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Holder;
  } catch {
    return undefined; // unreadable: treated like a crashed run's
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // it exists, but isn't ours to signal
  }
}
