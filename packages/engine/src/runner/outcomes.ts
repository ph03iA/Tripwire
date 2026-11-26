import { hasClient } from "../agents/types.js";
import type { AccountProfile, Label, TripwireEvent } from "../types.js";

/**
 * The world simulator's answer to a step-up (PRD R3): the one-time code goes to the registered phone, which the real
 * owner holds and an attacker doesn't. No scenario gives the attacker the phone yet; one that did would pass here.
 */
export const otpPasses = (label: Label) => !label.attack;

export type DenyRule = "lock.device" | "lock.unverified-device";
/** An event refused because of an earlier stop (PRD R2), with the rule that refused it and the stop it follows. */
export type Denial = { eventId: string; accountId: string; rule: DenyRule; stopEventId: string };

/** The events a stop guards on its account: payments and credential changes (R2). */
const isGuarded = (e: TripwireEvent) => e.kind === "transaction" || e.kind === "account_change" || e.kind === "password_reset";

/**
 * Stops are final for the attacker (PRD R2). After a BLOCK or a failed step-up, the device that triggered it is
 * refused on every account, and the account refuses payments and credential changes from any device that isn't in
 * its profile or hasn't passed a step-up on it.
 */
export function locks(profile: (accountId: string) => AccountProfile | undefined) {
  const lockedDevices = new Map<string, string>(); // device → the stop that locked it
  const lockedAccounts = new Map<string, string>(); // account → its first stop
  const verified = new Map<string, Set<string>>(); // account → devices that passed a step-up on it
  const isTrusted = (accountId: string, deviceId: string) =>
    profile(accountId)?.knownDevices.some((d) => d.id === deviceId) === true || verified.get(accountId)?.has(deviceId) === true;

  return {
    deny(e: TripwireEvent): Denial | null {
      const device = hasClient(e) ? e.deviceId : undefined;
      const deviceStop = device === undefined ? undefined : lockedDevices.get(device);
      if (deviceStop) return { eventId: e.id, accountId: e.accountId, rule: "lock.device", stopEventId: deviceStop };
      const accountStop = lockedAccounts.get(e.accountId);
      if (!accountStop || !isGuarded(e) || (device !== undefined && isTrusted(e.accountId, device))) return null;
      return { eventId: e.id, accountId: e.accountId, rule: "lock.unverified-device", stopEventId: accountStop };
    },
    stop(e: TripwireEvent) {
      if (hasClient(e) && !lockedDevices.has(e.deviceId)) lockedDevices.set(e.deviceId, e.id);
      if (!lockedAccounts.has(e.accountId)) lockedAccounts.set(e.accountId, e.id);
    },
    verify(e: TripwireEvent) {
      if (!hasClient(e)) return;
      const devices = verified.get(e.accountId) ?? new Set<string>();
      verified.set(e.accountId, devices.add(e.deviceId));
    },
  };
}
export type Locks = ReturnType<typeof locks>;
