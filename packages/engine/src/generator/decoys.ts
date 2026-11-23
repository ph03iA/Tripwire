import type { Client } from "../types.js";
import type { Rng } from "./rng.js";
import { CITIES, DAYS, MIN, RARE_UA, homeClient, ist, type Account, type Draft, type Merchant, type World } from "./world.js";

const LABEL = { scenario: "normal", attack: false } as const;
type Ctx = { rng: Rng; w: World; out: Draft[] };
type Payment = { type: "transfer" | "payout"; rupees: number; payeeId: string; payeeIsNew: boolean };

/**
 * Benign look-alikes: real customers who each share one suspicious trait with an attack, so that no single
 * field value appears only in attacks (checked in generate.test.ts). Each decoy gets accounts of its own.
 * Runs before profiles() so the rare-browser desktops count as known devices.
 */
export function decoys(rng: Rng, w: World, take: () => Account): Draft[] {
  const ctx: Ctx = { rng, w, out: [] };
  for (let i = 0; i < 3; i++) rareBrowserOwner(ctx, take(), i === 0);
  rareBrowserNewLaptop(ctx, take());
  for (const rupees of [rng.int(80_000, 99_000), rng.int(20_000, 60_000), rng.int(20_000, 60_000)]) newBankPayout(ctx, take(), rupees);
  supportResetByOwner(ctx, take(), false);
  supportResetByOwner(ctx, take(), true);
  supportChatEmailChange(ctx, take());
  webEmailChange(ctx, take());
  support(ctx, take(), daytime(ctx), "phone", "other");
  largePayments(ctx, take);
  cardChecks(ctx, take);
  return ctx.out;
}

/** Already owns a Linux desktop with the rare browser string, so it's in their profile. One of them mistypes twice. */
function rareBrowserOwner(ctx: Ctx, acc: Account, mistypes: boolean) {
  const device = ctx.w.newDevice(RARE_UA);
  acc.devices.push(device);
  const c = homeClient(acc, device);
  let t = daytime(ctx);
  if (mistypes) t = failedLogins(ctx, acc, c, t);
  login(ctx, acc, c, t);
  charge(ctx, acc, c, later(ctx, t), ctx.rng.int(200, 3000), ctx.rng.pick(acc.merchants));
  login(ctx, acc, c, daytime(ctx));
}

/** A new laptop with the rare browser string: two typos, then in. s1's victim login, but in daytime and with no spray. */
function rareBrowserNewLaptop(ctx: Ctx, acc: Account) {
  const c = homeClient(acc, ctx.w.newDevice(RARE_UA)); // one-off, so not in the profile
  login(ctx, acc, c, failedLogins(ctx, acc, c, daytime(ctx)));
}

/** Adds a new bank account and pays out to it, like s1/s5's payout to the mule. */
function newBankPayout(ctx: Ctx, acc: Account, rupees: number) {
  const c = homeClient(acc, acc.devices[0]!);
  let t = daytime(ctx);
  login(ctx, acc, c, t);
  t = later(ctx, t);
  ctx.out.push({ t, accountId: acc.id, ...c, kind: "account_change", field: "payout_method", channel: "app", label: LABEL });
  pay(ctx, acc, c, later(ctx, t), { type: "payout", rupees, payeeId: ctx.w.uid("bnk"), payeeIsNew: true });
}

/** s2's first two phases by the real owner: KBA call, reset via support, then a login on their own phone. */
function supportResetByOwner(ctx: Ctx, acc: Account, awayFromHome: boolean) {
  const c = homeClient(acc, acc.devices[0]!);
  let t = daytime(ctx);
  // Away from home: calling from a work phone in another city, like s2's caller.
  const caller = awayFromHome
    ? { phone: ctx.w.phone(), geo: ctx.rng.pick(CITIES.filter((g) => g.city !== acc.home.city)) }
    : undefined;
  support(ctx, acc, t, "phone", "reset_password", caller);
  t += ctx.rng.int(8, 15) * MIN;
  ctx.out.push({ t, accountId: acc.id, ...c, kind: "password_reset", channel: "support", label: LABEL });
  login(ctx, acc, c, later(ctx, t));
}

/** Email change through support chat after a KBA check. */
function supportChatEmailChange(ctx: Ctx, acc: Account) {
  const c = homeClient(acc, acc.devices[0]!);
  const t = daytime(ctx);
  support(ctx, acc, t, "chat", "change_email");
  ctx.out.push({ t: later(ctx, t), accountId: acc.id, ...c, kind: "account_change", field: "email", channel: "support", label: LABEL });
}

/** s1's phase 3, done by the owner on their own device. */
function webEmailChange(ctx: Ctx, acc: Account) {
  const c = homeClient(acc, acc.devices[0]!);
  const t = daytime(ctx);
  login(ctx, acc, c, t);
  ctx.out.push({ t: later(ctx, t), accountId: acc.id, ...c, kind: "account_change", field: "email", channel: "web", label: LABEL });
}

/** Big money moved by real owners, matching s2's transfer, s3's purchase and s1's payout amounts. */
function largePayments(ctx: Ctx, take: () => Account) {
  const { rng, w } = ctx;
  const payments: ((acc: Account, c: Client, t: number) => void)[] = [
    (acc, c, t) => pay(ctx, acc, c, t, { type: "transfer", rupees: rng.int(120_000, 200_000), payeeId: w.uid("pay"), payeeIsNew: true }),
    (acc, c, t) => pay(ctx, acc, c, t, { type: "transfer", rupees: rng.int(60_000, 150_000), payeeId: rng.pick(acc.payees), payeeIsNew: false }),
    (acc, c, t) => charge(ctx, acc, c, t, rng.int(25_000, 70_000), rng.pick(w.bigShops)),
    (acc, c, t) => charge(ctx, acc, c, t, rng.int(25_000, 70_000), rng.pick(w.bigShops)),
    (acc, c, t) => pay(ctx, acc, c, t, { type: "payout", rupees: rng.int(80_000, 99_000), payeeId: acc.bankPayee, payeeIsNew: false }),
  ];
  for (const payment of payments) {
    const acc = take();
    const c = homeClient(acc, acc.devices[0]!);
    const t = daytime(ctx);
    login(ctx, acc, c, t);
    payment(acc, c, later(ctx, t));
  }
}

/** Card checks of ₹1–₹10, like s3's probing. The first customer adds a card to three apps within minutes. */
function cardChecks(ctx: Ctx, take: () => Account) {
  for (let i = 0; i < 4; i++) {
    const acc = take();
    const c = homeClient(acc, acc.devices[0]!);
    let t = daytime(ctx);
    login(ctx, acc, c, t);
    for (const m of ctx.rng.shuffle(ctx.w.merchants).slice(0, i === 0 ? 3 : 1)) {
      t = later(ctx, t);
      charge(ctx, acc, c, t, ctx.rng.int(1, i === 0 ? 2 : 10), m);
    }
  }
}

const daytime = ({ rng }: Ctx) => ist(rng.int(0, DAYS - 1), rng.int(9, 20), rng.int(0, 59));
const later = ({ rng }: Ctx, t: number) => t + rng.int(1, 5) * MIN;

function login(ctx: Ctx, acc: Account, c: Client, t: number) {
  ctx.out.push({ t, accountId: acc.id, ...c, kind: "login", success: true, method: "password", label: LABEL });
}

/** Two mistyped passwords; returns the time for the next event. */
function failedLogins(ctx: Ctx, acc: Account, c: Client, t: number): number {
  for (let i = 0; i < 2; i++) {
    ctx.out.push({ t, accountId: acc.id, ...c, kind: "login", success: false, method: "password", failureReason: "bad_password", label: LABEL });
    t = later(ctx, t);
  }
  return t;
}

function charge(ctx: Ctx, acc: Account, c: Client, t: number, rupees: number, m: Merchant) {
  ctx.out.push({ t, accountId: acc.id, ...c, kind: "transaction", type: "card_charge", amountMinor: rupees * 100, currency: "INR",
    merchantId: m.id, merchantCategory: m.category, status: "approved", label: LABEL });
}

function pay(ctx: Ctx, acc: Account, c: Client, t: number, p: Payment) {
  ctx.out.push({ t, accountId: acc.id, ...c, kind: "transaction", type: p.type, amountMinor: p.rupees * 100, currency: "INR",
    payeeId: p.payeeId, payeeIsNew: p.payeeIsNew, status: "approved", label: LABEL });
}

/** A support contact that passes a KBA check, from the registered phone at home unless a caller is given. */
function support(ctx: Ctx, acc: Account, t: number, channel: "phone" | "chat", intent: "reset_password" | "change_email" | "other",
  caller = { phone: acc.phone, geo: acc.home }) {
  ctx.out.push({ t, accountId: acc.id, kind: "support_contact", channel, intent, callerPhone: caller.phone, callerGeo: caller.geo,
    verification: { method: "kba", passed: true }, label: LABEL });
}
