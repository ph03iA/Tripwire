import type { Client, Label, ScenarioId } from "../types.js";
import type { Rng } from "./rng.js";
import { CITIES, MIN, RARE_UA, UAS, homeClient, ist, type Account, type Draft, type World } from "./world.js";

const SEC = 1000;
type Planted = Omit<Label, "eventId">;
type Ctx = { rng: Rng; w: World; out: Draft[] };

/** The six planted scenarios from docs/design.md. Runs before background() so it can set blackouts. */
export function scenarios(rng: Rng, w: World, take: () => Account): Draft[] {
  const ctx: Ctx = { rng, w, out: [] };
  const mule = w.uid("bnk"); // s1 and s5 are one attacker, so one mule bank account
  stuffingTakeover(ctx, "s1_cred_stuffing", "s1", take(), Array.from({ length: 15 }, take), ist(3, 2, 10), mule);
  supportReset(ctx, take(), ist(5, 15));
  cardTesting(ctx, take(), ist(6, 23, 30));
  traveler(ctx, take(), ist(7, 9));
  fraudRing(ctx, Array.from({ length: 5 }, take), ist(8, 10));
  stuffingTakeover(ctx, "s5_repeat_attacker", "s5", take(), Array.from({ length: 12 }, take), ist(10, 2, 40), mule);
  return ctx.out;
}

const victim = (scenario: ScenarioId, chainId: string, step: number, takeover = false): Planted =>
  takeover
    ? { scenario, attack: true, chainId, role: "victim", step, takeoverStep: true }
    : { scenario, attack: true, chainId, role: "victim", step };

/** Attackers rent residential proxies, so their IPs and cities look like any customer's. */
const residential = ({ rng, w }: Ctx, userAgent: string): Client => ({
  ip: w.indianIp(),
  geo: rng.pick(CITIES),
  deviceId: w.uid("dev"),
  userAgent,
});

/**
 * s1/s5: low-and-slow credential stuffing (2–3 attempts per account, interleaved, so no account sees a burst),
 * then a new-device login → email change → payout to the mule. Same tool, cadence and browser string each time.
 */
function stuffingTakeover(ctx: Ctx, scenario: ScenarioId, chainId: string, v: Account, probes: Account[], start: number, mule: string) {
  const { rng, out } = ctx;
  let t = start;
  const attempts = rng.shuffle([v, v, ...probes.flatMap((a) => Array<Account>(rng.int(2, 3)).fill(a))]);
  for (const acc of attempts) {
    t += rng.int(30, 50) * SEC;
    const label: Planted = acc === v ? victim(scenario, chainId, 1) : { scenario, attack: true, chainId, role: "probe", step: 1 };
    out.push({ t, accountId: acc.id, ...residential(ctx, RARE_UA), kind: "login", success: false, method: "password",
      failureReason: "bad_password", label });
  }
  const atk = residential(ctx, RARE_UA);
  t += rng.int(1, 3) * MIN;
  out.push({ t, accountId: v.id, ...atk, kind: "login", success: true, method: "password", label: victim(scenario, chainId, 2) });
  t += rng.int(3, 6) * MIN;
  out.push({ t, accountId: v.id, ...atk, kind: "account_change", field: "email", channel: "web", label: victim(scenario, chainId, 3) });
  t += rng.int(4, 8) * MIN;
  out.push({ t, accountId: v.id, ...atk, kind: "transaction", type: "payout", amountMinor: rng.int(80_000, 99_000) * 100,
    currency: "INR", payeeId: mule, payeeIsNew: true, status: "approved", label: victim(scenario, chainId, 4, true) });
}

/** s2: a support call passes KBA from an unknown phone → reset via support → new-device login → ₹1,80,000 out. */
function supportReset(ctx: Ctx, v: Account, start: number) {
  const { rng, w, out } = ctx;
  const label = (step: number, takeover = false) => victim("s2_support_reset", "s2", step, takeover);
  let t = start;
  const callerGeo = rng.pick(CITIES.filter((g) => g.city !== v.home.city));
  out.push({ t, accountId: v.id, kind: "support_contact", channel: "phone", intent: "reset_password", callerPhone: w.phone(),
    callerGeo, verification: { method: "kba", passed: true }, label: label(1) });
  const c: Client = { ...residential(ctx, rng.pick(UAS)), geo: callerGeo }; // never added to the victim's devices
  t += rng.int(8, 15) * MIN;
  out.push({ t, accountId: v.id, ...c, kind: "password_reset", channel: "support", label: label(2) });
  t += rng.int(2, 5) * MIN;
  out.push({ t, accountId: v.id, ...c, kind: "login", success: true, method: "password", label: label(3) });
  t += rng.int(3, 7) * MIN;
  out.push({ t, accountId: v.id, ...c, kind: "transaction", type: "transfer", amountMinor: 180_000 * 100, currency: "INR",
    payeeId: w.uid("pay"), payeeIsNew: true, status: "approved", label: label(4, true) });
}

/** s3: card testing. Six ₹1–₹10 charges at different merchants, then a ₹45,000 electronics purchase. */
function cardTesting(ctx: Ctx, v: Account, start: number) {
  const { rng, w, out } = ctx;
  const c = residential(ctx, rng.pick(UAS));
  let t = start;
  for (const m of rng.shuffle(w.merchants).slice(0, 6)) {
    t += rng.int(1, 3) * MIN;
    out.push({ t, accountId: v.id, ...c, kind: "transaction", type: "card_charge", amountMinor: rng.int(1, 10) * 100,
      currency: "INR", merchantId: m.id, merchantCategory: m.category, status: rng.chance(0.3) ? "declined" : "approved",
      label: victim("s3_card_testing", "s3", 1) });
  }
  const big = rng.pick(w.merchants.filter((m) => m.category === "electronics"));
  t += rng.int(5, 10) * MIN;
  out.push({ t, accountId: v.id, ...c, kind: "transaction", type: "card_charge", amountMinor: 45_000 * 100, currency: "INR",
    merchantId: big.id, merchantCategory: big.category, status: "approved", label: victim("s3_card_testing", "s3", 2, true) });
}

/** s4: one device on five accounts about 10 h apart, each paying the same new payee. Each account is its own chain. */
function fraudRing(ctx: Ctx, victims: Account[], start: number) {
  const { rng, w, out } = ctx;
  const deviceId = w.uid("dev");
  const payeeId = w.uid("pay");
  const geo = rng.pick(CITIES);
  victims.forEach((v, i) => {
    const chainId = `s4-${i + 1}`;
    const c: Client = { ip: w.indianIp(), geo, deviceId, userAgent: UAS[0]! };
    let t = start + i * rng.int(540, 600) * MIN;
    out.push({ t, accountId: v.id, ...c, kind: "login", success: true, method: "password", label: victim("s4_fraud_ring", chainId, 1) });
    t += rng.int(6, 15) * MIN;
    out.push({ t, accountId: v.id, ...c, kind: "transaction", type: "transfer", amountMinor: rng.int(8000, 15_000) * 100,
      currency: "INR", payeeId, payeeIsNew: true, status: "approved", label: victim("s4_fraud_ring", chainId, 2, true) });
  });
}

/**
 * s6, not an attack: seen at home on their usual phone, then 2 h later in Bangkok on the same phone. Too far
 * for 2 h, so a crude impossible-travel rule fires; the phone is in their profile, so the policy caps it at STEP-UP.
 */
function traveler(ctx: Ctx, v: Account, tripLogin: number) {
  const { rng, w, out } = ctx;
  const device = v.devices[0]!;
  const label = { scenario: "s6_traveler", attack: false } as const;
  w.blackout.set(v.id, [tripLogin - 180 * MIN, ist(10, 0)]); // keep other traffic away from the fixture and the trip
  out.push({ t: tripLogin - 120 * MIN, accountId: v.id, ...homeClient(v, device), kind: "login", success: true,
    method: "password", label });
  const c: Client = { ip: `27.55.${rng.int(0, 255)}.${rng.int(1, 254)}`, geo: { country: "TH", city: "Bangkok" },
    deviceId: device.id, userAgent: device.userAgent };
  let t = tripLogin;
  out.push({ t, accountId: v.id, ...c, kind: "login", success: true, method: "password", label });
  for (let i = 0; i < 3; i++) {
    const m = rng.pick(w.merchants.filter((x) => x.category === "travel" || x.category === "food_delivery"));
    t += rng.int(60, 240) * MIN;
    out.push({ t, accountId: v.id, ...c, kind: "transaction", type: "card_charge", amountMinor: rng.int(800, 4000) * 100,
      currency: "INR", merchantId: m.id, merchantCategory: m.category, status: "approved", label });
  }
}
