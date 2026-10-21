# Auto apply: credit and lifecycle contract

Approved by the owner on 2026-10-21. The server enforces everything here.
The extension, the board, MCP and /apply only display it. A change to these
rules is a change to this file first.

## Three events

An application credit goes through at most three events, and they mean
different things.

1. **Reserved.** One credit is held for one attempt, so no other tab,
   device or run can use it. Nothing has been sent.
2. **Submission started.** The server has acknowledged that the extension
   is about to press the site's Submit. This is a boundary, not proof: the
   click may never happen, or the employer may never receive it.
3. **Charged.** The attempt is settled as Submitted (the site confirmed) or
   Submission unconfirmed (sent or possibly sent, outcome unknown).

A reservation or an acknowledged submission start is never shown, counted
or described as a submitted application.

## Rules

R1. **Reserve before anything is sent.** Starting an attempt reserves one
credit in one transaction. It succeeds only if, for every limit that
applies, charged plus reserved is below the limit. Of two requests for the
last credit, exactly one succeeds.

R2. **One attempt per job.** The same transaction locks the job by
canonical identity (the ATS's own job id, `apply.canonical_job`). While an
attempt is open, or once the job is Submitted or Submission unconfirmed, a
new attempt for it is refused.

R3. **Submission start needs the server's acknowledgement.** Immediately
before pressing Submit, the extension reports `submission_started` and
waits for the server to acknowledge it. No acknowledgement, no click: if
the report fails or times out, the extension does not submit.

R4. **Charge on confirmation.** The site's confirmation settles the attempt
as Submitted and turns the reservation into a charge. Final.

R5. **Charge provisionally on an unknown outcome.** After an acknowledged
submission start, no confirmation within the window, a closed tab, a lost
network response, or a crash before or after the click settles the attempt
as Submission unconfirmed: charged, shown as unconfirmed everywhere,
disputable (R12), and never retried automatically.

R6. **Release when the site shows nothing was sent.** After a submission
start, the form still on the page with the site's own validation errors
settles as Failed and releases the credit. A disappearing form alone
proves nothing either way.

R7. **Release every failure before submission start.** Page didn't load, no
form, a field couldn't be filled, no submit button, a CAPTCHA, a question
the profile can't answer, a limit or rule refused it: Failed, Skipped or
Needs input, released.

R8. **Filling is not sending.** A fill the user hasn't sent is Filled,
recorded in History, never reserved or charged.

R9. **Reservations expire after 30 minutes, on the server.** An attempt
still Reserved at expiry becomes Abandoned and is released. An attempt in
Submission started at expiry becomes Submission unconfirmed and is charged
(R5). The server applies expiry whenever it reads a user's state and in a
periodic sweep, so it never depends on the extension staying open.

R10. **Idempotency.** Every attempt has an id made by the extension.
Repeating start, submission started, settle or dispute with the same id and
the same request returns the same answer and changes nothing. The same id
with a different request is refused.

R11. **Retries.** A retry is a new attempt with a new id. It is allowed only
after the previous attempt is resolved in a released state (Failed,
Skipped, Abandoned, Needs input once answered, Not sent (disputed)) and only
when the job is queued or the user starts it.

R12. **Disputes.** The user can dispute a Submission unconfirmed within 14
days of settlement ("it wasn't sent"). An accepted dispute refunds the
credit at once and marks the attempt Not sent (disputed). The original
attempt and its audit trail stay. Each user has 5 dispute requests per
billing period; that is an allowance of requests, not a promise of 5
refunds. A refund for one attempt can happen once. Submitted (confirmed by
the site) is not disputable.

R13. **Periods.** The period and the user's time zone are fixed on the
attempt when it is reserved. A later report, a delayed settle or a time
zone change never moves the charge to another period.

R14. **Limits.**
- Free: 30 per calendar month. Basic: 100 per calendar month. Pro: 50 per
  day and no monthly limit.
- The user's own daily maximum (Settings, optional) applies on every plan,
  on top of the plan's limit.
- Both are checked in R1's transaction: a monthly plan checks the month's
  count and, when set, the day's count against the user's daily maximum;
  Pro checks the day's count against the lower of 50 and the user's daily
  maximum.
- A plan change applies from the moment it happens. Charges already made
  stay. What's left is the new limit minus charged minus reserved, never
  below zero.

R15. **AI answers are not applications.** They have their own monthly
meter, counted only when an answer is produced. A job waiting on a question
is paused as Needs input, so no generation runs again until the user
answers.

## States

| State | Reached by | Credit | Next |
|---|---|---|---|
| Queued | added by the user, the board or an assistant | none | Reserved, removed |
| Reserved | start (R1, R2) | reserved | Submission started, Failed, Skipped, Needs input, Abandoned |
| Submission started | acknowledged report (R3) | reserved | Submitted, Submission unconfirmed, Failed (R6 only) |
| Submitted | site confirmation (R4) | charged | final |
| Submission unconfirmed | R5, or expiry after submission start (R9) | charged, provisionally | Submitted if confirmed later, Not sent (disputed) |
| Not sent (disputed) | accepted dispute (R12) | refunded | Queued, by the user |
| Failed | R6, R7 | released | Queued (R11) |
| Needs input | R7, R15 | released | Queued once answered |
| Skipped | not attempted | none | Queued (R11) |
| Abandoned | expiry before submission start (R9) | released | Queued (R11) |
| Filled | an unsent fill (R8) | none | Reserved, if the user sends it from the card |

Any transition not in this table is refused.

## Invariants the tests must hold

1. One attempt id can never consume or refund a credit twice.
2. A retry always gets a new attempt id and is permitted only after the
   previous attempt is released or otherwise explicitly resolved.
3. An unconfirmed submission is never retried automatically.
4. A crash or a lost response cannot create a second charge when a report
   is retried.
5. The server is authoritative for reservations, settlements, period limits
   and disputes.

## Required regression tests before any client switches

- Concurrent reservations for the last credit, from several threads: one
  succeeds.
- Concurrent reservations for one job: one succeeds.
- A crash after each event (reserved, submission started, settled): expiry
  and retried reports resolve it per R5, R9 and R10, with exactly one
  charge or none.
- Duplicate reports: start, submission started, settle and dispute each
  repeated, and repeated with a different body.
- Expiry at 29 and 31 minutes, in both open states.
- Disputes: accepted once, refused on repeat, refused after 14 days,
  refused past the 5th request in a period, refused for Submitted.
- A delayed settle after a period boundary and after a time zone change
  charges the original period.

Until these pass, the current flow (`claim` and `result` in apply.py) stays
as it is.
