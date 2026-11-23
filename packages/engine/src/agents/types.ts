import type { History } from "../store/store.js";
import type { AccountProfile, AgentName, Client, RiskSignal, SignalType, TripwireEvent } from "../types.js";

/** A rule's verdict on one event, before the pipeline adds the rule's id and signal type. */
export type Hit = { score: number; evidence: string };
export type Finding = Hit & { ruleId: string; type: SignalType };

export type AgentContext = {
  history: History;
  profile(accountId: string): AccountProfile | undefined;
  /** Share of all profiles' known devices that use this browser string, from 0 to 1. */
  uaShare(userAgent: string): number;
};

type RuleMeta = {
  id: string; // "login.failure-burst": shown in traces and knowledge/risk-rules.md
  type: SignalType;
  when: string; // one sentence with the thresholds, rendered into knowledge/risk-rules.md
};
export type Rule = RuleMeta & { fire(e: TripwireEvent, ctx: AgentContext): Promise<Hit | null> };
/** Runs only when the agent's base findings reach the recall threshold, against the signals it recalled. */
export type ContextRule = RuleMeta & { fire(e: TripwireEvent, recalled: RiskSignal[]): Hit | null };

export type Agent = {
  name: AgentName;
  sees: string; // which events it handles, for knowledge/risk-rules.md
  handles(e: TripwireEvent): boolean;
  rules: Rule[];
  contextRules: ContextRule[];
};

export type ClientEvent = TripwireEvent & Client;
export const hasClient = (e: TripwireEvent): e is ClientEvent => "deviceId" in e;

/** ISO time a number of minutes before the event. */
export const minutesBefore = (e: TripwireEvent, minutes: number) => new Date(Date.parse(e.ts) - minutes * 60_000).toISOString();
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
