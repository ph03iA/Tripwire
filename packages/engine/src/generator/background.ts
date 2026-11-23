import type { Client, StepUpResultEvent, SupportContactEvent, TripwireEvent } from "../types.js";
import type { Rng } from "./rng.js";
import { CITIES, DAY, DAYS, MIN, START, ist, type Account, type DistributiveOmit, type Draft, type World } from "./world.js";

const LABEL = { scenario: "normal", attack: false } as const;
const AVG_SESSION_EVENTS = 2.55; // measured events per session for the mix below
const MAX_SESSION = 60 * MIN; // no session runs longer, so checking its start keeps a blackout clean

type Session = { events: Draft[]; mutates: boolean }; // mutates: added a device, payee or bank that later sessions may use
type Visit = { rng: Rng; w: World; acc: Account; c: Client; s: Session; t: number };
type ClientEvent = Exclude<TripwireEvent, SupportContactEvent | StepUpResultEvent>;
type Body = DistributiveOmit<ClientEvent, "id" | "ts" | "accountId" | keyof Client>;

/**
 * Normal customer traffic, plus benign noise that looks a bit like attacks: new phones and bank accounts,
 * new payees, typos, KBA support calls, tiny and very large payments, domestic trips. Builds ~5% more sessions
 * than needed, then drops whole sessions at random, so the stream never goes over `target` events.
 */
export function background(rng: Rng, w: World, target: number): Draft[] {
  const sessions: Session[] = [];
  for (const start of sessionStarts(rng, target)) {
    const acc = rng.pick(w.accounts);
    if (!inBlackout(w, acc, start)) sessions.push(session(rng, w, acc, start));
  }
  return trimToTarget(rng, sessions, target);
}

/** Session start times in order, so device, payee and bank lists change in time order. */
function sessionStarts(rng: Rng, target: number): number[] {
  return Array.from({ length: Math.ceil((target / AVG_SESSION_EVENTS) * 1.05) }, () => {
    const hour = rng.chance(0.9) ? rng.int(7, 23) : rng.int(0, 6);
    const t = ist(rng.int(0, DAYS - 1), hour, rng.int(0, 59));
    return t < START ? t + DAY : t; // IST early hours of day 0 fall before the stream starts
  }).sort((a, b) => a - b);
}

function inBlackout(w: World, acc: Account, start: number): boolean {
  const off = w.blackout.get(acc.id);
  return off !== undefined && start >= off[0] - MAX_SESSION && start < off[1];
}

/** Things that sometimes happen before the login, with their odds. */
const BEFORE_LOGIN: [number, (x: Visit) => void][] = [
  [0.008, supportCall],
  [0.01, (x) => emit(x, { kind: "password_reset", channel: "email" })],
  [0.08, failedLogins],
];

/** One visit: maybe a support call, reset or typos, a login, maybe a profile change, then 0–3 payments. */
function session(rng: Rng, w: World, acc: Account, start: number): Session {
  const s: Session = { events: [], mutates: false };
  const x: Visit = { rng, w, acc, s, c: clientFor(rng, w, acc, s), t: start };
  for (const [odds, step] of BEFORE_LOGIN) if (rng.chance(odds)) step(x);
  emit(x, { kind: "login", success: true, method: rng.chance(0.2) ? "otp" : "password" });
  if (rng.chance(0.015)) profileChange(x);
  for (let k = rng.int(0, 3); k > 0; k--) payment(x);
  return s;
}

function clientFor(rng: Rng, w: World, acc: Account, s: Session): Client {
  let device = rng.pick(acc.devices);
  if (rng.chance(0.04)) {
    acc.devices.push((device = w.newDevice())); // got a new phone
    s.mutates = true;
  }
  return {
    ip: rng.chance(0.3) ? w.indianIp() : device.ip, // mobile networks hand out new IPs
    geo: rng.chance(0.005) ? rng.pick(CITIES) : acc.home, // domestic trip
    deviceId: device.id,
    userAgent: device.userAgent,
  };
}

/** Adds an event at the visit's clock, then moves the clock on. */
function emit(x: Visit, body: Body) {
  x.s.events.push({ ...body, ...x.c, accountId: x.acc.id, t: x.t, label: LABEL });
  x.t += x.rng.int(1, 5) * MIN;
}

/** A call or chat to the support desk. 40% are verified by security questions (KBA), and a few come from another phone or city. */
function supportCall(x: Visit) {
  const { rng, w, acc } = x;
  x.s.events.push({ t: x.t, accountId: acc.id, label: LABEL, kind: "support_contact", channel: rng.chance(0.5) ? "phone" : "chat",
    intent: rng.pick(["other", "other", "reset_password", "change_email"] as const),
    callerPhone: rng.chance(0.9) ? acc.phone : w.phone(), callerGeo: rng.chance(0.95) ? acc.home : rng.pick(CITIES),
    verification: { method: rng.chance(0.4) ? "kba" : "otp", passed: rng.chance(0.95) } });
  x.t += rng.int(1, 5) * MIN;
}

/** One mistyped password, sometimes two or three. */
function failedLogins(x: Visit) {
  for (let k = x.rng.chance(0.25) ? x.rng.int(2, 3) : 1; k > 0; k--) {
    emit(x, { kind: "login", success: false, method: "password", failureReason: "bad_password" });
  }
}

function profileChange(x: Visit) {
  emit(x, { kind: "account_change", field: x.rng.pick(["phone", "email", "password"] as const), channel: x.rng.chance(0.5) ? "app" : "web" });
}

function payment(x: Visit) {
  const r = x.rng.next();
  if (r < 0.8) cardCharge(x);
  else if (r < 0.97) transfer(x);
  else payout(x);
}

/** Mostly ₹50–₹6,000 at their usual shops; 4% are ₹1–₹49 card checks and 1% are ₹20,000–₹80,000 big purchases. */
function cardCharge(x: Visit) {
  const { rng, w, acc } = x;
  const r = rng.next();
  const [shop, rupees] =
    r < 0.04 ? [rng.pick(w.merchants), rng.int(1, 49)]
    : r < 0.05 ? [rng.pick(w.bigShops), rng.int(20_000, 80_000)]
    : [rng.chance(0.8) ? rng.pick(acc.merchants) : rng.pick(w.merchants), rng.int(50, 6000)];
  emit(x, { kind: "transaction", type: "card_charge", amountMinor: rupees * 100, currency: "INR", merchantId: shop.id,
    merchantCategory: shop.category, status: status(rng) });
}

/** 15% go to a new payee; 3% are ₹50,000–₹2,00,000. */
function transfer(x: Visit) {
  const { rng, w, acc } = x;
  const payeeIsNew = rng.chance(0.15);
  const payeeId = payeeIsNew ? w.uid("pay") : rng.pick(acc.payees);
  if (payeeIsNew) {
    acc.payees.push(payeeId);
    x.s.mutates = true;
  }
  const rupees = rng.chance(0.03) ? rng.int(50_000, 200_000) : rng.int(500, 25_000);
  emit(x, { kind: "transaction", type: "transfer", amountMinor: rupees * 100, currency: "INR", payeeId, payeeIsNew, status: status(rng) });
}

/** To the customer's bank. 8% first switch to a new bank account; 5% are ₹40,000–₹1,50,000. */
function payout(x: Visit) {
  const { rng, w, acc } = x;
  const newBank = rng.chance(0.08);
  if (newBank) {
    emit(x, { kind: "account_change", field: "payout_method", channel: "app" });
    acc.bankPayee = w.uid("bnk");
    x.s.mutates = true;
  }
  const rupees = rng.chance(0.05) ? rng.int(40_000, 150_000) : rng.int(1000, 40_000);
  emit(x, { kind: "transaction", type: "payout", amountMinor: rupees * 100, currency: "INR", payeeId: acc.bankPayee,
    payeeIsNew: newBank, status: status(rng) });
}

const status = (rng: Rng): "approved" | "declined" => (rng.chance(0.97) ? "approved" : "declined");

/** Drops random sessions that changed nothing later sessions rely on, until the total fits. */
function trimToTarget(rng: Rng, sessions: Session[], target: number): Draft[] {
  let total = sessions.reduce((n, s) => n + s.events.length, 0);
  const dropped = new Set<Session>();
  for (const s of rng.shuffle(sessions.filter((x) => !x.mutates))) {
    if (total <= target) break;
    dropped.add(s);
    total -= s.events.length;
  }
  return sessions.filter((s) => !dropped.has(s)).flatMap((s) => s.events);
}
