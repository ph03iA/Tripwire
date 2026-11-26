# Step-up policy

How Tripwire turns risk into an action. The decision agent quotes this policy in every decision it explains.

## Actions by risk

Risk is the noisy-OR of the strongest signal of each type on the account, and on its device, IP address and payee, in the last 72 hours.

- **BLOCK** at risk 0.8 or more. The action is refused and the attacker is locked out (see "After a stop").
- **STEP-UP** at risk from 0.5 up to 0.8. A one-time code goes to the account's registered phone. The action continues only if the code is entered.
- **ALLOW** below 0.5.

## Caps

- **Known device, travel only.** When the only risk is impossible travel, on a device in the account's profile, the action is capped at STEP-UP. Real customers travel with their own phones, and a code to that phone settles it.
- **The agents' models alone.** When only the signals the agents' models added put the risk at 0.8 or more, the action is capped at STEP-UP. A block needs the rules' own evidence; a step-up still stops an attacker, who can't enter the code.

## When a decision runs

- On every sensitive event: a change of email, phone, password, payout method or two-factor setting; a password reset; any transfer or payout; a card charge of ₹10,000 or more.
- On any event that produces a signal scoring 0.7 or more.
- Every other event is allowed without review and listed, with its reason, in the day's allow ledger.

## Why a step-up stops an attacker

The code goes to the phone on file, not to the person asking. Someone who passed the support desk's security questions, or who holds only a password, can't enter it. A failed step-up counts as a stop, exactly like a block.

## After a stop

- The device that triggered the stop is refused on every account.
- The account refuses payments, password resets and account changes from any device that isn't in its profile and hasn't passed a step-up on it. The owner's own phone keeps working.
