import { PGlite } from "@electric-sql/pglite";
import type { TripwireEvent } from "../types.js";

// shortcut: PGlite in memory, one run per database; switch openStore() to a pg Pool on Meko AMP once K5 confirms the Free plan has it.
const SCHEMA = `
create table events (
  seq integer primary key,
  id text unique not null,
  ts timestamptz not null,
  account_id text not null,
  kind text not null,
  success boolean, channel text,
  device_id text, ip text, user_agent text,
  type text, amount_minor integer, payee_id text, payee_is_new boolean, merchant_id text,
  city text, country text,
  body jsonb not null
);
create index events_account_ts on events (account_id, ts);
create index events_device_ts on events (device_id, ts);
`;

/** Event fields copied into their own columns, in insert order. Anything else stays in `body`. */
const COLUMNS = ["success", "channel", "deviceId", "ip", "userAgent", "type", "amountMinor", "payeeId", "payeeIsNew", "merchantId"] as const;
const INSERT = `insert into events (seq, id, ts, account_id, kind, success, channel, device_id, ip, user_agent, type,
  amount_minor, payee_id, payee_is_new, merchant_id, city, country, body) values (${Array.from({ length: 18 }, (_, i) => `$${i + 1}`)})`;

export type LastActivity = { ts: Date; city: string; country: string };

/** Read-only questions agents ask about earlier events. The store never holds an event that hasn't been replayed yet. */
export type History = {
  failedLogins(accountId: string, since: string): Promise<number>;
  lastActivity(accountId: string): Promise<LastActivity | null>;
  resetSince(accountId: string, since: string, channel?: "support"): Promise<boolean>;
  deviceSeenOnAccount(accountId: string, deviceId: string): Promise<boolean>;
  otherAccountsOnDevice(deviceId: string, accountId: string, since: string): Promise<number>;
  smallCharges(accountId: string, since: string): Promise<{ count: number; merchants: string[] }>;
  medianAmount(accountId: string): Promise<{ median: number | null; count: number }>;
};

export type EventStore = History & {
  /** Call after the agents have seen the event, so queries only ever see strictly earlier events. */
  insert(e: TripwireEvent, seq: number): Promise<void>;
  close(): Promise<void>;
};

export async function openStore(): Promise<EventStore> {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await db.query<T>(sql, params)).rows[0]!;
  const exists = async (sql: string, params: unknown[]) => (await one<{ found: boolean }>(`select exists(${sql}) as found`, params)).found;

  return {
    insert: async (e, seq) => void (await db.query(INSERT, row(e, seq))),
    close: () => db.close(),

    failedLogins: async (accountId, since) => (await one<{ n: number }>(
      `select count(*)::int as n from events where account_id = $1 and kind = 'login' and success = false and ts >= $2`,
      [accountId, since])).n,

    // Failed attempts don't place the user anywhere, so they don't count as activity.
    lastActivity: async (accountId) => (await db.query<LastActivity>(
      `select ts, city, country from events where account_id = $1 and city is not null
         and not (kind = 'login' and success = false) order by seq desc limit 1`, [accountId])).rows[0] ?? null,

    resetSince: (accountId, since, channel) => exists(
      `select 1 from events where account_id = $1 and kind = 'password_reset' and ts >= $2 and ($3::text is null or channel = $3)`,
      [accountId, since, channel ?? null]),

    deviceSeenOnAccount: (accountId, deviceId) => exists(
      `select 1 from events where account_id = $1 and device_id = $2`, [accountId, deviceId]),

    otherAccountsOnDevice: async (deviceId, accountId, since) => (await one<{ n: number }>(
      `select count(distinct account_id)::int as n from events where device_id = $1 and account_id <> $2 and ts >= $3`,
      [deviceId, accountId, since])).n,

    smallCharges: (accountId, since) => one(
      `select count(*)::int as count, coalesce(array_agg(distinct merchant_id), '{}') as merchants from events
         where account_id = $1 and type = 'card_charge' and amount_minor < 5000 and ts >= $2`, [accountId, since]),

    medianAmount: (accountId) => one(
      `select percentile_cont(0.5) within group (order by amount_minor) as median, count(*)::int as count
         from events where account_id = $1 and kind = 'transaction'`, [accountId]),
  };
}

function row(e: TripwireEvent, seq: number): unknown[] {
  const fields = e as unknown as Record<string, unknown>;
  const geo = "geo" in e ? e.geo : undefined; // support calls carry callerGeo, which isn't where a device is
  return [seq, e.id, e.ts, e.accountId, e.kind, ...COLUMNS.map((k) => fields[k] ?? null), geo?.city ?? null, geo?.country ?? null,
    JSON.stringify(e)];
}
