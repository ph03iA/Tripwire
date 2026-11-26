import type { TripwireEvent } from "../types.js";
import { isSensitive } from "./decision.js";

/**
 * Pattern readings: what an agent's recent events share across accounts, measured by code for the agent's model to
 * judge. Per-account rules can't see these, such as one browser failing logins on many accounts at a steady pace.
 */
type Key = { kind: string; of: (e: TripwireEvent) => string | undefined; minAccounts: number };
const KEYS: Key[] = [
  { kind: "browser", of: (e) => ("userAgent" in e ? e.userAgent : undefined), minAccounts: 3 }, // common browsers are shared anyway
  { kind: "IP address", of: (e) => ("ip" in e ? e.ip : undefined), minAccounts: 2 },
  { kind: "device", of: (e) => ("deviceId" in e ? e.deviceId : undefined), minAccounts: 2 },
  { kind: "payee", of: (e) => (e.kind === "transaction" ? e.payeeId : undefined), minAccounts: 2 },
  { kind: "caller phone", of: (e) => (e.kind === "support_contact" ? e.callerPhone : undefined), minAccounts: 2 },
];
export const PATTERN_WINDOW_MS = 60 * 60_000;
const MAX_READINGS = 8;
const ATTACK_KEYS = KEYS.slice(0, 3); // browser, IP address, device
const ATTACK_ACCOUNTS = 5;
const ATTACK_FAILURES = 5;

type Group = { kind: string; value: string; events: TripwireEvent[]; accounts: number };

/** Each browser, IP address, device, payee or caller phone that several accounts share in `events`, most accounts first. */
export function patternReadings(events: TripwireEvent[], uaShare: (ua: string) => number): string[] {
  return KEYS.flatMap((k) => groupsBy(k, events))
    .sort((a, b) => b.accounts - a.accounts || b.events.length - a.events.length || a.value.localeCompare(b.value))
    .slice(0, MAX_READINGS)
    .map((g) => reading(g, uaShare));
}

function groupsBy(key: Key, events: TripwireEvent[]): Group[] {
  const byValue = new Map<string, TripwireEvent[]>();
  for (const e of events) {
    const value = key.of(e);
    if (value !== undefined) byValue.set(value, [...(byValue.get(value) ?? []), e]);
  }
  return [...byValue].map(([value, group]) => ({ kind: key.kind, value, events: group, accounts: new Set(group.map((e) => e.accountId)).size }))
    .filter((g) => g.accounts >= key.minAccounts);
}

function reading({ kind, value, events, accounts }: Group, uaShare: (ua: string) => number): string {
  const times = events.map((e) => Date.parse(e.ts)).sort((a, b) => a - b);
  const minutes = Math.round((times.at(-1)! - times[0]!) / 60_000);
  const logins = events.filter((e) => e.kind === "login");
  const failed = logins.filter((e) => !e.success).length;
  const share = kind === "browser" ? ` (on ${(uaShare(value) * 100).toFixed(1)}% of known devices)` : "";
  return `${kind} "${value}"${share}: ${accounts} accounts, ${events.length} events in ${minutes} min `
    + `(${failed} failed logins, ${logins.length - failed} successful, ${events.length - logins.length} other), `
    + `median gap ${medianGapSeconds(times)} s, latest ${events.at(-1)!.id}`;
}

function medianGapSeconds(times: number[]): number {
  const gaps = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
  return gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]! / 1000) : 0;
}

/**
 * The pattern alarm: a successful login or a sensitive event that shares a browser, IP address or device with failed
 * logins on many accounts in `window`. Its batch is reviewed at once, so the agent's model judges it before its decision.
 * It decides only when the model looks, never what happens.
 */
export function inLoginAttack(e: TripwireEvent, window: TripwireEvent[]): boolean {
  if (!((e.kind === "login" && e.success) || isSensitive(e))) return false;
  return ATTACK_KEYS.some((key) => {
    const value = key.of(e);
    const group = value === undefined ? [] : window.filter((x) => key.of(x) === value);
    return new Set(group.map((x) => x.accountId)).size >= ATTACK_ACCOUNTS && group.filter(isFailedLogin).length >= ATTACK_FAILURES;
  });
}

const isFailedLogin = (e: TripwireEvent) => e.kind === "login" && !e.success;

/** The events a batch's readings cover: the agent's events, the batch's included, in the hour up to the batch's last event. */
export function patternWindow(batch: TripwireEvent[], earlier: TripwireEvent[]): TripwireEvent[] {
  const last = Date.parse(batch.at(-1)!.ts);
  return [...earlier, ...batch].filter((e) => last - Date.parse(e.ts) <= PATTERN_WINDOW_MS);
}
