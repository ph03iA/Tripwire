import type { LoginEvent, TripwireEvent } from "../types.js";
import { speedKmh } from "./geo.js";
import { type Agent, type Rule, minutesBefore } from "./types.js";

const failedLogin = (e: TripwireEvent): e is LoginEvent => e.kind === "login" && !e.success;
const successfulLogin = (e: TripwireEvent): e is LoginEvent => e.kind === "login" && e.success;

const failureBurst: Rule = {
  id: "login.failure-burst",
  type: "credential_stuffing",
  when: "a failed login brings the account to 5 or more failures in 15 minutes (0.6), or 10 or more (0.8)",
  async fire(e, { history }) {
    if (!failedLogin(e)) return null;
    const failures = 1 + (await history.failedLogins(e.accountId, minutesBefore(e, 15)));
    if (failures < 5) return null;
    return { score: failures >= 10 ? 0.8 : 0.6, evidence: `${failures} failed logins on the account in 15 min` };
  },
};

const failuresThenSuccess: Rule = {
  id: "login.failures-then-success",
  type: "failures_then_success",
  when: "a successful login follows 2 or more failed logins in the previous 30 minutes (0.3)",
  async fire(e, { history }) {
    if (!successfulLogin(e)) return null;
    const failures = await history.failedLogins(e.accountId, minutesBefore(e, 30));
    return failures >= 2 ? { score: 0.3, evidence: `success after ${failures} failed logins in 30 min` } : null;
  },
};

// Failed attempts come from rotating proxies and don't place the user anywhere, so only successful activity counts.
const impossibleTravel: Rule = {
  id: "login.impossible-travel",
  type: "impossible_travel",
  when: "a successful login is too far from the account's last successful activity to reach at 900 km/h (0.7)",
  async fire(e, { history }) {
    if (!successfulLogin(e)) return null;
    const last = await history.lastActivity(e.accountId);
    if (!last) return null;
    const kmh = speedKmh(last.city, e.geo.city, Date.parse(e.ts) - last.ts.getTime());
    if (kmh === null || kmh <= 900) return null;
    return { score: 0.7, evidence: `${last.city} to ${e.geo.city} would need ${Math.round(kmh)} km/h` };
  },
};

const afterSupportReset: Rule = {
  id: "login.after-support-reset",
  type: "login_after_support_reset",
  when: "a successful login comes within 60 minutes of a password reset done by the support desk (0.7)",
  async fire(e, { history }) {
    if (!successfulLogin(e)) return null;
    const reset = await history.resetSince(e.accountId, minutesBefore(e, 60), "support");
    return reset ? { score: 0.7, evidence: "login within 60 min of a support-desk password reset" } : null;
  },
};

export const loginAgent: Agent = {
  name: "login",
  sees: "logins and password resets",
  handles: (e) => e.kind === "login" || e.kind === "password_reset",
  rules: [failureBurst, failuresThenSuccess, impossibleTravel, afterSupportReset],
  contextRules: [],
};
