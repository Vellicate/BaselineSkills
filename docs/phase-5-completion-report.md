# Phase 5 Completion Report — Payments & Invoices

## What was implemented

**Provider abstraction** (`lib/payments/index.js`, `paddle.js`, `paypal.js`): a clean,
provider-agnostic interface — `registration.js` never needs to know which provider a given
registration is using. `require("../lib/payments")` resolves unchanged via the directory's
`index.js`, so no other file needed its import path updated.

**Full PayPal integration**: OAuth2 client-credentials token handling (cached until near
expiry), order creation, capture, and PayPal's own webhook signature verification API — a
genuinely different mechanism from Paddle's local HMAC, and correctly implemented as such
rather than forced into the same shape. When both providers are configured, the learner is
shown a real choice between them rather than one being silently picked.

**Invoice generation** (`lib/invoices.js`): a PDF invoice, with Baseline Skills branding,
generated automatically on genuine payment confirmation — course fee, certification exam
fee (if purchased), discount, and total as separate line items, plus invoice number,
date, and payment reference. Sequential, human-readable invoice numbers
(`BS-2026-000001`), not raw database ids. Downloadable from the learner's account page,
with server-side ownership enforcement, not just a hidden link.

## Master Prompt sections addressed
13, 14, per the Phased Implementation document's Phase 5 scope.

## Two critical, pre-existing bugs found and fixed — more significant than anything built new this phase

**1. Every webhook call was being silently blocked by the CSRF protection added two
sessions ago.** `requireSameOrigin` fails closed when there's no Origin or Referer header
— exactly how a real webhook from Paddle or PayPal's own servers arrives, since it's a
server-to-server call, not a browser request. This meant the *authoritative* payment
confirmation path Section 12 requires had been unreachable since that CSRF fix was
applied. Found by specifically testing a webhook call with no Origin header — not by
re-confirming the cases already known to pass. The bug existed in **two** places
(`registration.js` and `public.js`), since Express runs middleware from every router
mounted at an overlapping path in request order, regardless of which router's route
ultimately handles it — fixing only the router that defines the webhook routes wasn't
enough.

**2. Even after that fix, Paddle webhook signature verification still failed — because it
had likely never worked at all.** The global `bodyParser.json()` in `app.js` was consuming
the request body before the webhook route's own `express.raw()` middleware ever ran.
`req.body` arrived as an already-parsed JS object, and the signature computation's
template string silently turned that into the literal text `"[object Object]"` instead of
the real payload — meaning the HMAC comparison could never succeed, on any payload, ever.
Fixed by excluding `/webhooks/*` from the global JSON parser, so each webhook route's own
raw/json parser gets the request body first.

**Both fixes verified end-to-end, not just reasoned about**: a properly HMAC-signed
webhook payload — built via a file-based approach specifically to rule out shell-quoting
artifacts in the test itself — now succeeds (200) and correctly transitions a registration
from `invoice_pending` to `confirmed`. A genuine duplicate of that same signed webhook was
then isolated and confirmed not to trigger a second email, proving real idempotency rather
than just a 200 response.

## What was tested, and the result

- Invoice generation fires only on genuine confirmation, never on the `invoice_pending`
  fallback (verified directly — no invoice row exists after a fallback-only registration).
- The generated PDF was read back with a real PDF parser (not just checked for existence)
  and confirmed to contain the correct invoice number, total, and course title.
- Ownership enforcement on invoice download: the owning learner succeeds (200); a
  different learner is blocked (403); an anonymous visitor is redirected to log in.
- Full regression across every phase: public routes, duplicate-registration blocking,
  admin login and course creation, learner signup, account page, and review-eligibility
  blocking (no purchase) all still work correctly after every change in this session.

## Deferred, explicitly

Real tax/VAT calculation and actual payment-gateway-fee reporting are not yet built — the
invoice PDF states this plainly ("n/a — not yet calculated/reported") rather than
fabricating a number, since inventing a tax figure would be a worse outcome than an honest
gap. Corporate invoicing (the `invoices` table's original `corporateAccountId` use case)
remains untouched and is Phase 6+/corporate-feature scope, not this phase's.

## Confirmation

Nothing in this phase uses mock data, a placeholder workflow, or a simulated result — both
critical bugs were confirmed via real signed webhook requests reaching real handler code,
and the invoice was verified by actually parsing the generated PDF back, not by trusting
that file creation succeeded.
