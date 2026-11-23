# Playbook: travel that looks impossible

## How it looks
- A customer is active at home, then signs in from another country a couple of hours later on the same phone.
- The distance can't be covered in the time, so a simple impossible-travel rule fires. Clock skew, IP geolocation errors and flights booked from home all cause this.

## Signals that matter
- Impossible travel on its own is weak evidence.
- What decides it is whether the device is one the account already owns, and whether anything else is wrong: new device, credential change, new payee, failed logins.

## Response
- Known device and travel only: STEP-UP at most, never BLOCK. A code to their own phone settles it in seconds.
- Travel together with a new device or a credential change is a takeover signal and follows the normal policy.

## Look-alikes
This playbook is about the look-alike: the real customer abroad. Blocking them is the false positive we most want to avoid.
