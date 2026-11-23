# Risk rules

Generated from `packages/engine/src/agents` by `npm run knowledge`. Don't edit by hand: a test fails when this file and the code disagree.

Each rule scores one event from 0 to 1 (the score is in brackets). An agent's findings on one event combine as noisy-OR, 1 − Π(1 − s). When they reach 0.2, the agent recalls the signals it can see. Each finding of 0.4 or more is shared as a signal.

## Login agent

Sees logins and password resets.

| Rule | Signal | Fires when |
| --- | --- | --- |
| `login.failure-burst` | credential_stuffing | a failed login brings the account to 5 or more failures in 15 minutes (0.6), or 10 or more (0.8) |
| `login.failures-then-success` | failures_then_success | a successful login follows 2 or more failed logins in the previous 30 minutes (0.3) |
| `login.impossible-travel` | impossible_travel | a successful login is too far from the account's last successful activity to reach at 900 km/h (0.7) |
| `login.after-support-reset` | login_after_support_reset | a successful login comes within 60 minutes of a password reset done by the support desk (0.7) |

## Device agent

Sees every event that has device fields: logins, resets, account changes and transactions.

| Rule | Signal | Fires when |
| --- | --- | --- |
| `device.new-device` | new_device | the device isn't in the account's profile and has never been used on the account (0.4) |
| `device.shared` | shared_device | the device was used by other accounts in the last 7 days (0.5 for one, 0.7 for two, 0.8 for three or more) |
| `device.rare-ua` | rare_user_agent | the browser string is on fewer than 2% of the devices in all account profiles (0.2) |
| `device.new-after-reset` | new_device_after_reset | a password reset is made from a new device, or a new device appears within 60 minutes of a reset (0.6) |

## Transaction agent

Sees card charges, transfers and payouts.

| Rule | Signal | Fires when |
| --- | --- | --- |
| `txn.card-testing` | card_testing | a charge under ₹50 makes 3 or more such charges at 3 or more merchants in 30 minutes (0.6) |
| `txn.cash-out-after-testing` | card_testing | a charge of ₹10,000 or more comes within 60 minutes of 3 or more charges under ₹50 at 3 or more merchants (0.8) |
| `txn.high-value-new-payee` | high_value_new_payee | a transfer of ₹50,000 or more goes to a new payee (0.5), or ₹1,00,000 or more (0.6) |
| `txn.payout-new-bank` | payout_new_bank | a payout goes to a new bank account (0.4), or ₹50,000 or more does (0.6) |
| `txn.amount-anomaly` | amount_anomaly | a transaction of ₹10,000 or more is at least 5 times the median of 3 or more earlier transactions (0.4) |

## Support agent

Sees support-desk contacts and account changes.

| Rule | Signal | Fires when |
| --- | --- | --- |
| `support.weak-verification` | weak_verification | a password-reset or email-change request is verified only by security questions (0.5), or not at all (0.6) |
| `support.caller-mismatch` | caller_mismatch | the caller's phone isn't the registered one (0.3), or the caller is also outside the home city (0.4) |
| `support.sensitive-change` | sensitive_change | an email, phone, payout-method or 2FA change is made (0.4) |
| `support.change-after-new-device` | sensitive_change | after recall: a sensitive change comes within 60 minutes of a new-device signal on the account (0.6) |
