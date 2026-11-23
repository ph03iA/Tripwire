import type { AccountChangeEvent, TripwireEvent } from "../types.js";
import type { Agent, ContextRule, Rule } from "./types.js";

const SENSITIVE_FIELDS = new Set(["email", "phone", "payout_method", "2fa_off"]);
const VERIFICATION_SCORE = { kba: 0.5, none: 0.6, otp: 0 } as const; // security questions are weaker than an OTP
const HOUR = 3_600_000;

const isSensitiveChange = (e: TripwireEvent): e is AccountChangeEvent => e.kind === "account_change" && SENSITIVE_FIELDS.has(e.field);

const weakVerification: Rule = {
  id: "support.weak-verification",
  type: "weak_verification",
  when: "a password-reset or email-change request is verified only by security questions (0.5), or not at all (0.6)",
  async fire(e) {
    if (e.kind !== "support_contact" || e.intent === "other") return null;
    const score = VERIFICATION_SCORE[e.verification.method];
    return score > 0 ? { score, evidence: `${e.intent.replace("_", " ")} request verified by ${e.verification.method}` } : null;
  },
};

const callerMismatch: Rule = {
  id: "support.caller-mismatch",
  type: "caller_mismatch",
  when: "the caller's phone isn't the registered one (0.3), or the caller is also outside the home city (0.4)",
  async fire(e, { profile }) {
    if (e.kind !== "support_contact") return null;
    const p = profile(e.accountId);
    if (!p || e.callerPhone === p.registeredPhone) return null;
    const away = e.callerGeo.city !== p.home.city;
    return { score: away ? 0.4 : 0.3, evidence: away ? `unknown phone calling from ${e.callerGeo.city}` : "caller phone not on file" };
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

const changeAfterNewDevice: ContextRule = {
  id: "support.change-after-new-device",
  type: "sensitive_change",
  when: "after recall: a sensitive change comes within 60 minutes of a new-device signal on the account (0.6)",
  fire(e, recalled) {
    if (!isSensitiveChange(e)) return null;
    const at = Date.parse(e.ts);
    const device = recalled.find((s) => s.type === "new_device" && s.accountId === e.accountId && at - Date.parse(s.ts) <= HOUR);
    if (!device) return null;
    return { score: 0.6, evidence: `${e.field} change ${Math.round((at - Date.parse(device.ts)) / 60_000)} min after a new-device login` };
  },
};

export const supportAgent: Agent = {
  name: "support",
  sees: "support-desk contacts and account changes",
  handles: (e) => e.kind === "support_contact" || e.kind === "account_change",
  rules: [weakVerification, callerMismatch, sensitiveChange],
  contextRules: [changeAfterNewDevice],
};
