import type { TransactionEvent, TripwireEvent } from "../types.js";
import { type Agent, type Rule, minutesBefore, rupees } from "./types.js";

const SMALL = 5_000; // paise: a charge under ₹50 counts as a card check
const LARGE = 1_000_000; // ₹10,000
const HIGH = 5_000_000; // ₹50,000
const VERY_HIGH = 10_000_000; // ₹1,00,000

const isCharge = (e: TripwireEvent): e is TransactionEvent => e.kind === "transaction" && e.type === "card_charge";
const isNewDestination = (e: TripwireEvent, type: "transfer" | "payout"): e is TransactionEvent =>
  e.kind === "transaction" && e.type === type && e.payeeIsNew === true;

const cardTesting: Rule = {
  id: "txn.card-testing",
  type: "card_testing",
  when: "a charge under ₹50 makes 3 or more such charges at 3 or more merchants in 30 minutes (0.6)",
  async fire(e, { history }) {
    if (!isCharge(e) || e.amountMinor >= SMALL) return null;
    const earlier = await history.smallCharges(e.accountId, minutesBefore(e, 30));
    const merchants = new Set([...earlier.merchants, e.merchantId]).size;
    if (earlier.count + 1 < 3 || merchants < 3) return null;
    return { score: 0.6, evidence: `${earlier.count + 1} charges under ₹50 at ${merchants} merchants in 30 min` };
  },
};

const cashOutAfterTesting: Rule = {
  id: "txn.cash-out-after-testing",
  type: "card_testing",
  when: "a charge of ₹10,000 or more comes within 60 minutes of 3 or more charges under ₹50 at 3 or more merchants (0.8)",
  async fire(e, { history }) {
    if (!isCharge(e) || e.amountMinor < LARGE) return null;
    const earlier = await history.smallCharges(e.accountId, minutesBefore(e, 60));
    if (earlier.count < 3 || earlier.merchants.length < 3) return null;
    return { score: 0.8, evidence: `${rupees(e.amountMinor)} charge after ${earlier.count} card checks at ${earlier.merchants.length} merchants` };
  },
};

const highValueNewPayee: Rule = {
  id: "txn.high-value-new-payee",
  type: "high_value_new_payee",
  when: "a transfer of ₹50,000 or more goes to a new payee (0.5), or ₹1,00,000 or more (0.6)",
  async fire(e) {
    if (!isNewDestination(e, "transfer") || e.amountMinor < HIGH) return null;
    return { score: e.amountMinor >= VERY_HIGH ? 0.6 : 0.5, evidence: `${rupees(e.amountMinor)} to a new payee` };
  },
};

const payoutNewBank: Rule = {
  id: "txn.payout-new-bank",
  type: "payout_new_bank",
  when: "a payout goes to a new bank account (0.4), or ₹50,000 or more does (0.6)",
  async fire(e) {
    if (!isNewDestination(e, "payout")) return null;
    return { score: e.amountMinor >= HIGH ? 0.6 : 0.4, evidence: `${rupees(e.amountMinor)} payout to a new bank account` };
  },
};

const amountAnomaly: Rule = {
  id: "txn.amount-anomaly",
  type: "amount_anomaly",
  when: "a transaction of ₹10,000 or more is at least 5 times the median of 3 or more earlier transactions (0.4)",
  async fire(e, { history }) {
    if (e.kind !== "transaction" || e.amountMinor < LARGE) return null;
    const { median, count } = await history.medianAmount(e.accountId);
    if (median === null || count < 3 || e.amountMinor < 5 * median) return null;
    return { score: 0.4, evidence: `${rupees(e.amountMinor)} is ${(e.amountMinor / median).toFixed(1)}× the usual ${rupees(median)}` };
  },
};

export const txnAgent: Agent = {
  name: "txn",
  sees: "card charges, transfers and payouts",
  handles: (e) => e.kind === "transaction",
  rules: [cardTesting, cashOutAfterTesting, highValueNewPayee, payoutNewBank, amountAnomaly],
  contextRules: [],
};
