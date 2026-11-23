# Playbook: credential stuffing ("low and slow")

## How it looks
- An attacker tries leaked passwords against many accounts: two or three attempts per account, a steady 30–50 seconds apart, usually overnight.
- The IP addresses are residential and rotate across ordinary cities, so no single address or account sees a burst.
- One tool does the work, so the browser string stays the same across every attempt, and it is usually a rare one.
- When a password works, the attacker signs in from a new device, changes the account email within minutes, then pays out to a new bank account.

## Signals that matter
- A successful login after failures, on a device the account has never used.
- A sensitive change (email, phone, payout method) soon after a new-device login.
- A payout to a new bank account, especially a large one.
- The same rare browser string and cadence across many accounts' failed logins in the same hour.

## Response
- Step up the first sensitive change after a new-device login. The code goes to the real owner's phone, so the attacker can't finish.
- Once a case is confirmed, save the attacker's indicators (browser string, cadence, mule bank account) as a pattern. The next run of the same tool can then be stopped at the login.

## Look-alikes
- Customers who mistype a password twice and then sign in.
- Customers with a new phone.
- Customers who add a new bank account and pay out to it.
None of these come with a spray of failures across other accounts at the same time.
