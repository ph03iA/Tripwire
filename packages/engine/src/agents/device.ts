import type { TripwireEvent } from "../types.js";
import { type Agent, type AgentContext, type ClientEvent, type Rule, hasClient, minutesBefore } from "./types.js";

const SHARED_SCORE = [0, 0.5, 0.7, 0.8]; // by number of other accounts on the device, capped at 3

/** The event shows the device was actually used on the account. A failed login doesn't: the device never got in. */
const usesDevice = (e: TripwireEvent): e is ClientEvent => hasClient(e) && !(e.kind === "login" && !e.success);

async function isNewDevice(e: ClientEvent, ctx: AgentContext): Promise<boolean> {
  const inProfile = ctx.profile(e.accountId)?.knownDevices.some((d) => d.id === e.deviceId);
  return !inProfile && !(await ctx.history.deviceSeenOnAccount(e.accountId, e.deviceId));
}

// 0.4 so it is shared: other agents need it (for example, a sensitive change right after a new-device login).
const newDevice: Rule = {
  id: "device.new-device",
  type: "new_device",
  when: "the device isn't in the account's profile and has never been used on the account; failed logins don't count (0.4)",
  async fire(e, ctx) {
    if (!usesDevice(e) || !(await isNewDevice(e, ctx))) return null;
    return { score: 0.4, evidence: `first time ${e.deviceId} is used on the account` };
  },
};

const sharedDevice: Rule = {
  id: "device.shared",
  type: "shared_device",
  when: "the device was used by other accounts in the last 7 days (0.5 for one, 0.7 for two, 0.8 for three or more)",
  async fire(e, { history }) {
    if (!hasClient(e)) return null;
    const others = await history.otherAccountsOnDevice(e.deviceId, e.accountId, minutesBefore(e, 7 * 24 * 60));
    if (others === 0) return null;
    return { score: SHARED_SCORE[Math.min(others, 3)]!, evidence: `${e.deviceId} used by ${others} other account(s) in 7 days` };
  },
};

const rareBrowser: Rule = {
  id: "device.rare-ua",
  type: "rare_user_agent",
  when: "the browser string is on fewer than 2% of the devices in all account profiles (0.2)",
  async fire(e, { uaShare }) {
    if (!hasClient(e)) return null;
    const share = uaShare(e.userAgent);
    return share < 0.02 ? { score: 0.2, evidence: `browser string on ${(share * 100).toFixed(1)}% of known devices` } : null;
  },
};

const newDeviceAroundReset: Rule = {
  id: "device.new-after-reset",
  type: "new_device_after_reset",
  when: "a password reset is made from a new device, or a new device appears within 60 minutes of a reset (0.6)",
  async fire(e, ctx) {
    if (!usesDevice(e) || !(await isNewDevice(e, ctx))) return null;
    const resetNow = e.kind === "password_reset";
    if (!resetNow && !(await ctx.history.resetSince(e.accountId, minutesBefore(e, 60)))) return null;
    return { score: 0.6, evidence: resetNow ? "password reset from a new device" : "new device within 60 min of a password reset" };
  },
};

export const deviceAgent: Agent = {
  name: "device",
  sees: "every event that has device fields: logins, resets, account changes and transactions",
  handles: hasClient,
  rules: [newDevice, sharedDevice, rareBrowser, newDeviceAroundReset],
  contextRules: [],
};
