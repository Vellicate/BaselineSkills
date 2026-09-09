# Rigorous Cross-Module Testing Report — All Modules Together

Scope: genuine integration and stress testing across every module built so far, targeting
combinations and load conditions specifically not covered by any single phase's own
testing — not a re-confirmation of individual features in isolation.

## Two real bugs found, both financial-document-integrity issues — both fixed and verified

**1. The invoice's "Discount applied" line silently omitted the exam's own discount.**
When a registration included both a discounted course and a discounted certification exam,
the invoice only subtracted the course's discount, understating the customer's true total
savings — e.g., showing $150 when the real combined discount was $180. The grand total
itself was still arithmetically correct (computed independently from the registration's
actual charged amount), which is exactly why this could have gone unnoticed indefinitely —
nothing about the bottom line looked wrong. Found by deliberately combining two features
that had each been tested separately (a genuine early-bird discount, not just a course's
flat rate, together with an exam add-on) and reading the actual generated PDF rather than
trusting the total. Fixed by summing both items' discounts; verified the corrected combined
figure ($180) on a fresh invoice.

**2. A genuine, confirmed race condition in invoice numbering under real concurrent load.**
Five simultaneous webhook confirmations (a realistic scenario — nothing about production
traffic guarantees payments confirm one at a time) produced only 3 successful invoices; the
other 2 failed outright with a database UNIQUE constraint violation and were silently
logged and dropped — meaning those two registrations became permanently confirmed and paid
with no invoice ever generated, and no retry mechanism to fix it. Root cause: the invoice
number was computed from a row count, but the actual database insert claiming that number
happened only *after* an async PDF-generation step — a real yield point where a second
concurrent request could read the same "next" count before the first had inserted its row.
Fixed by claiming the number via an immediate, fully synchronous insert with zero `await`
points before the async PDF work begins — closing the interleaving window entirely, since
Node's single-threaded event loop cannot interrupt a synchronous block partway through.
Verified by re-running the *same* concurrent test, then a larger one (8 simultaneous
confirmations, more than the original 5): zero collisions, exactly 8 unique sequential
numbers both times.

## Verified empirically, not just reasoned about

Given the CSRF/webhook bugs from the previous session were themselves initially "fixed" on
reasoning that turned out to be incomplete, this pass deliberately re-checked a piece of
that reasoning that hadn't been directly tested: whether `auth.js`'s own blanket CSRF
middleware (mounted *after* `registration.js` in the request chain) could still intercept a
webhook request before it reaches its handler. Tested directly rather than trusted:
confirmed both `/webhooks/paddle` and `/webhooks/paypal` correctly reach their real
handlers (401 "Invalid signature" from the actual verification logic, not CSRF's "missing
Origin/Referer" rejection) — auth.js's middleware is confirmed never reached for these
paths, since registration.js's own webhook routes terminate the response first.

## Full regression after both fixes

Every public route, duplicate-registration blocking, a genuine signed webhook confirming a
registration, the resulting invoice appearing correctly on the account page, review
submission now succeeding once a real confirmed purchase exists, admin login, and admin
course creation all confirmed working together in one continuous pass.

## Confirmation

Both bugs in this report were found by combining features across phases in ways not
previously tested together (discount + exam in one invoice; genuine parallel webhook
load) — the specific kind of gap that testing each feature correctly in isolation cannot
surface, since neither bug was visible in any single-feature test that had already passed.
