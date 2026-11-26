import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoginEvent, TripwireEvent } from "../types.js";
import { agentBatch, BATCH_SIZE } from "./batch.js";
import { inLoginAttack, patternReadings } from "./readings.js";

const RARE = "Mozilla/5.0 (X11; Linux x86_64) Chrome/118.0";
const COMMON = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1)";
const T0 = Date.parse("2026-11-03T20:40:00Z");
let n = 0;
const login = (account: string, secondsIn: number, success: boolean, ua = RARE, extra: Partial<LoginEvent> = {}): LoginEvent => ({
  id: `evt_${String(++n).padStart(4, "0")}`, ts: new Date(T0 + secondsIn * 1000).toISOString(), accountId: account, kind: "login", success,
  method: "password", ip: `49.36.${n}.1`, geo: { country: "IN", city: "Mumbai" }, deviceId: `dev_${n}`, userAgent: ua, ...extra,
});
// s1's shape: one rare browser, a new IP address and device each time, 38 failures on 16 accounts about 40 s apart, then a success.
const spray = Array.from({ length: 38 }, (_, i) => login(`acc_${i % 16}`, i * 40, false));
const success = login("acc_3", 38 * 40, true);
const legit = [login("acc_90", 100, true, COMMON), login("acc_91", 900, true, COMMON)];
const uaShare = (ua: string) => (ua === RARE ? 0.013 : 0.24);

test("pattern readings measure what accounts share: the spray's browser, its failures and its pace", () => {
  const readings = patternReadings([...spray, success, ...legit], uaShare);
  assert.equal(readings.length, 1, "a common browser on 2 accounts isn't a reading");
  assert.match(readings[0]!, /^browser "Mozilla\/5\.0 \(X11; Linux x86_64\) Chrome\/118\.0" \(on 1\.3% of known devices\): 16 accounts, 39 events in 25 min/);
  assert.match(readings[0]!, /38 failed logins, 1 successful, 0 other\), median gap 40 s, latest evt_\d+$/);
  const shared = login("acc_50", 10, true, COMMON, { deviceId: "dev_shared" });
  assert.match(patternReadings([shared, login("acc_51", 20, true, COMMON, { deviceId: "dev_shared" })], uaShare)[0]!, /^device "dev_shared": 2 accounts/);
});

test("the pattern alarm: a success or sensitive event inside a login attack, and nothing else", () => {
  const window = [...spray, success];
  assert.equal(inLoginAttack(success, window), true);
  assert.equal(inLoginAttack(spray[37]!, window), false, "a failed login waits for its batch");
  assert.equal(inLoginAttack(legit[0]!, [...window, legit[0]!]), false, "another browser");
  assert.equal(inLoginAttack(success, [...spray.slice(0, 4), success]), false, "4 failures isn't an attack");
});

test("a batch waits until it's full, unless a decision with evidence touches what it holds, or the alarm trips", () => {
  const batch = agentBatch();
  const first = login("acc_1", 0, true, COMMON);
  batch.add(first, []);
  const unrelated = login("acc_2", 60, true, COMMON);
  batch.add(unrelated, []);
  assert.equal(batch.closer(unrelated, true), null, "nothing in the batch shares its account, device, IP or payee");
  const sameAccount = login("acc_1", 120, true, COMMON);
  batch.add(sameAccount, []);
  assert.equal(batch.closer(sameAccount, false), null, "no decision with evidence");
  assert.equal(batch.closer(sameAccount, true), "decision");
  const taken = batch.take(uaShare);
  assert.deepEqual(taken.events.map((e) => e.id), [first.id, unrelated.id, sameAccount.id]);
  assert.equal(batch.size(), 0);

  for (const e of spray) batch.add(e, []);
  batch.add(success, []);
  assert.equal(batch.closer(success, false), "alarm");
  batch.take(uaShare);
  const many: TripwireEvent[] = Array.from({ length: BATCH_SIZE }, (_, i) => login(`acc_${100 + i}`, 3000 + i, true, COMMON));
  for (const e of many) batch.add(e, []);
  assert.equal(batch.closer(many.at(-1)!, false), "size");
});
