import type { AccountChangeEvent, RiskSignal, TripwireEvent } from "../types.js";
import type { Agent, ContextRule, Rule } from "./types.js";

const SENSITIVE_FIELDS = new Set(["email", "phone", "payout_method", "2fa_off"]);
const VERIFICATION_SCORE = { kba: 0.5, none: 0.6, otp: 0 } as const; // security questions are weaker than an OTP
const FAILED_CHECK = 0.4; // a failed check grants nothing, but someone tried
const HOUR = 3_600_000;

/** By caller phone (on file or not) and location (home city or not). The registered phone at home is fine. */
const CALLER: Record<string, { score: number; evidence(city: string): string }> = {
  "unknown,away": { score: 0.4, evidence: (city) => `unknown phone calling from ${city}` },
  "unknown,home": { score: 0.3, evidence: () => "caller phone not on file" },
  "registered,away": { score: 0.2, evidence: (city) => `registered phone calling from ${city}, outside the home city` },
};

const isSensitiveChange = (e: TripwireEvent): e is AccountChangeEvent => e.kind === "account_change" && SENSITIVE_FIELDS.has(e.field);

const weakVerification: Rule = {
  id: "support.weak-verification",
  type: "weak_verification",
  when: "a password-reset or email-change request is verified only by security questions (0.5) or not at all (0.6); a failed check on one scores (0.4)",
  async fire(e) {
    if (e.kind !== "support_contact" || e.intent === "other") return null;
    const { method, passed } = e.verification;
    const request = e.intent.replace("_", " ");
    if (!passed) return { score: FAILED_CHECK, evidence: `failed ${method} check on a ${request} request` };
    const score = VERIFICATION_SCORE[method];
    return score > 0 ? { score, evidence: `${request} request verified by ${method}` } : null;
  },
};

const callerMismatch: Rule = {
  id: "support.caller-mismatch",
  type: "caller_mismatch",
  when: "the caller's phone isn't the registered one (0.3), or is also outside the home city (0.4); the registered phone calling from outside the home city scores (0.2)",
  async fire(e, { profile }) {
    if (e.kind !== "support_contact") return null;
    const p = profile(e.accountId);
    if (!p) return null;
    const key = `${e.callerPhone === p.registeredPhone ? "registered" : "unknown"},${e.callerGeo.city === p.home.city ? "home" : "away"}`;
    const caller = CALLER[key];
    return caller ? { score: caller.score, evidence: caller.evidence(e.callerGeo.city) } : null;
  },
};

const sensitiveChange: Rule = {
  id: "support.sensitive-change",
  type: "sensitive_change",
  when: "an email, phone, payout-method or 2FA change is made (0.4)",
  async fire(e) {
    return isSensitiveChange(e) ? { score: 0.4, evidence: `${e.field} changed via ${e.channel}` } : null;
  },
};

/** A new-device signal from a successful login (failed logins never produce one) on the same account, in the hour before. */
function isEarlierNewDeviceLogin(s: RiskSignal, e: TripwireEvent): boolean {
  const gap = Date.parse(e.ts) - Date.parse(s.ts);
  return s.type === "new_device" && s.eventKind === "login" && s.accountId === e.accountId && s.eventId !== e.id && gap >= 0 && gap <= HOUR;
}

const changeAfterNewDevice: ContextRule = {
  id: "support.change-after-new-device",
  type: "sensitive_change",
  when: "after recall: a sensitive change comes within 60 minutes after a successful login from a new device on the account (0.6)",
  fire(e, recalled) {
    if (!isSensitiveChange(e)) return null;
    const login = recalled.find((s) => isEarlierNewDeviceLogin(s, e));
    if (!login) return null;
    const minutes = Math.round((Date.parse(e.ts) - Date.parse(login.ts)) / 60_000);
    return { score: 0.6, evidence: `${e.field} change ${minutes} min after a login from a new device` };
  },
};

export const supportAgent: Agent = {
  name: "support",
  sees: "support-desk contacts and account changes",
  handles: (e) => e.kind === "support_contact" || e.kind === "account_change",
  rules: [weakVerification, callerMismatch, sensitiveChange],
  contextRules: [changeAfterNewDevice],
};
