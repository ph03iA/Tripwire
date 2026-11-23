import type { AccountProfile, Client, Geo, Label, TripwireEvent } from "../types.js";
import type { Rng } from "./rng.js";

export const START = Date.UTC(2026, 10, 1); // 2026-11-01T00:00Z
export const DAYS = 14;
export const MIN = 60_000;
export const DAY = 86_400_000;

/** UTC ms for a day offset and an IST (UTC+5:30) wall-clock time. */
export const ist = (day: number, hour: number, minute = 0) => START + day * DAY + (hour * 60 + minute - 330) * MIN;

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before it gets its id and ISO timestamp, still carrying its label. */
export type Draft = DistributiveOmit<TripwireEvent, "id" | "ts"> & { t: number; label: Omit<Label, "eventId"> };

export const CITIES: Geo[] = ["Mumbai", "Bengaluru", "Delhi", "Pune", "Hyderabad", "Chennai", "Kolkata", "Ahmedabad"].map(
  (city) => ({ country: "IN", city }),
);
const IN_PREFIXES = ["49.36", "106.51", "117.99", "152.58", "223.185"];
const CATEGORIES = ["grocery", "food_delivery", "fuel", "electronics", "travel", "utilities", "digital_goods", "apparel"];
export const UAS = [
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "TripPay/4.2.0 (Android 13; Redmi Note 12)",
];
/** An old desktop Chrome on Linux: rare among customers, used by the s1/s5 attacker and by a few decoys. */
export const RARE_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36";

export type Device = { id: string; userAgent: string; ip: string };
export type Merchant = { id: string; category: string };
export type Account = {
  id: string;
  phone: string;
  home: Geo;
  devices: Device[];
  payees: string[];
  bankPayee: string;
  merchants: Merchant[];
};

export function makeWorld(rng: Rng, accountCount = 150) {
  const used = new Set<string>();
  // Random-looking ids everywhere, so no id hints at which entities are attackers.
  const uid = (prefix: string) => {
    for (;;) {
      const id = `${prefix}_${rng.hex(6)}`;
      if (!used.has(id)) return used.add(id), id;
    }
  };
  const indianIp = () => `${rng.pick(IN_PREFIXES)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  const phone = () => `+91${rng.int(70000, 99999)}${rng.int(10000, 99999)}`;
  const newDevice = (userAgent = rng.pick(UAS)): Device => ({ id: uid("dev"), userAgent, ip: indianIp() });

  const merchants: Merchant[] = Array.from({ length: 40 }, (_, i) => ({
    id: uid("mer"),
    category: CATEGORIES[i % CATEGORIES.length]!,
  }));
  const accounts: Account[] = Array.from({ length: accountCount }, (_, i) => ({
    id: `acc_${String(i + 1).padStart(4, "0")}`,
    phone: phone(),
    home: rng.pick(CITIES),
    devices: Array.from({ length: rng.int(1, 2) }, () => newDevice()),
    payees: Array.from({ length: rng.int(1, 4) }, () => uid("pay")),
    bankPayee: uid("bnk"),
    merchants: Array.from({ length: rng.int(3, 6) }, () => rng.pick(merchants)),
  }));

  return {
    accounts,
    merchants,
    /** Where large purchases happen. */
    bigShops: merchants.filter((m) => m.category === "electronics" || m.category === "travel"),
    uid,
    indianIp,
    phone,
    newDevice,
    /** Time windows when background traffic must skip an account (e.g. the traveler is abroad). */
    blackout: new Map<string, [number, number]>(),
  };
}

export type World = ReturnType<typeof makeWorld>;

/** The client fields for a customer on one of their own devices, at home. */
export const homeClient = (acc: Account, d: Device): Client => ({ ip: d.ip, geo: acc.home, deviceId: d.id, userAgent: d.userAgent });

/** What the app knows about each customer before the stream starts. Call before background() adds devices and payees. */
export const profiles = (w: World): AccountProfile[] =>
  w.accounts.map((a) => ({
    id: a.id,
    registeredPhone: a.phone,
    home: a.home,
    knownDevices: a.devices.map(({ id, userAgent }) => ({ id, userAgent })),
    knownPayees: [...a.payees],
    bankPayee: a.bankPayee,
  }));
