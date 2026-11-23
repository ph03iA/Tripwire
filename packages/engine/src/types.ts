export type Geo = { country: string; city: string };

/** Where an event came from. Phone support calls have no client, so they carry caller fields instead. */
export type Client = { ip: string; geo: Geo; deviceId: string; userAgent: string };

type Base = { id: string; ts: string; accountId: string };

export type LoginEvent = Base & Client & {
  kind: "login";
  success: boolean;
  method: "password" | "otp";
  failureReason?: "bad_password" | "locked";
};

export type PasswordResetEvent = Base & Client & {
  kind: "password_reset";
  channel: "email" | "sms" | "support";
};

export type AccountChangeEvent = Base & Client & {
  kind: "account_change";
  field: "email" | "phone" | "password" | "payout_method" | "2fa_off";
  channel: "web" | "app" | "support";
};

export type SupportContactEvent = Base & {
  kind: "support_contact";
  channel: "phone" | "chat";
  intent: "reset_password" | "change_email" | "other";
  callerPhone: string;
  callerGeo: Geo;
  verification: { method: "kba" | "otp" | "none"; passed: boolean };
};

export type TransactionEvent = Base & Client & {
  kind: "transaction";
  type: "card_charge" | "transfer" | "payout";
  amountMinor: number; // paise
  currency: "INR";
  merchantId?: string;
  merchantCategory?: string;
  payeeId?: string;
  payeeIsNew?: boolean;
  status: "approved" | "declined";
};

/** Written by the runner when a STEP_UP is answered; the generator never emits it. */
export type StepUpResultEvent = Base & { kind: "step_up_result"; passed: boolean };

export type TripwireEvent =
  | LoginEvent
  | PasswordResetEvent
  | AccountChangeEvent
  | SupportContactEvent
  | TransactionEvent
  | StepUpResultEvent;

export type ScenarioId =
  | "normal"
  | "s1_cred_stuffing"
  | "s2_support_reset"
  | "s3_card_testing"
  | "s4_fraud_ring"
  | "s5_repeat_attacker"
  | "s6_traveler";

/** Ground truth. Kept out of the event stream so agents can't see it. */
export type Label = {
  eventId: string;
  scenario: ScenarioId;
  attack: boolean;
  chainId?: string; // victim chain: "s1", "s2", "s3", "s4-1"…"s4-5", "s5"
  role?: "victim" | "probe"; // probe = attacker traffic against an account that isn't the chain's victim
  step?: number; // phase in the attack chain, 1-based; several events can share a phase
  takeoverStep?: boolean; // the event where money leaves
};

/** What the payments app knows about a customer before the stream starts. Agents may read it. */
export type AccountProfile = {
  id: string;
  registeredPhone: string;
  home: Geo;
  knownDevices: { id: string; userAgent: string }[];
  knownPayees: string[];
  bankPayee: string;
};
