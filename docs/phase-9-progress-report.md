# Phase 9 Progress Report — Security, Error Handling & SEO

Phase 9 covers the Master Prompt's remaining cross-cutting sections (security hardening,
non-functional requirements, deployment readiness, final documentation) not addressed by
Phases 0–8's functional work. Given the real scope of a complete Phase 9, this is a first,
verified installment — not a claim that every remaining item is closed. What's done below
is genuinely done and tested; what's not is named explicitly.

## What was implemented and tested this session

**A global error handler — the most important fix in this pass.** Until now, this app had
no error-handling middleware at all: an uncaught exception from any route fell through to
Express's own default handler, which renders a full stack trace directly to the visitor.
This wasn't theoretical — it's exactly what happened during earlier testing (a course-form
render missing a variable, an unhandled Multer error), both found and fixed individually at
the time, but the underlying gap that let *any* future uncaught error do the same thing was
never closed until now. Verified directly with two deliberate test routes — one throwing
synchronously, one throwing inside an `async` handler after an `await` — confirming Express
5's native async-error forwarding actually works in this app (not assumed from the
changelog): both show the clean, generic error page, the server stays alive afterward, and
the real error with its full stack trace is still logged server-side for debugging. The
temporary test routes were removed immediately after confirming.

**A properly scoped Content-Security-Policy**, added where none existed before. Built from
an actual grep of every external domain referenced anywhere in the codebase (Paddle,
PayPal, Google Fonts) rather than guessed — the existing code comment had already flagged
this as a known gap ("not a substitute for a full policy"). `'unsafe-inline'` is included
for scripts and styles because this app uses inline `<script>` blocks throughout (the
Paddle/PayPal checkout initializers, header modal interactivity); a nonce-based policy would
be stronger but needs per-render wiring this app doesn't have. HSTS is added conditionally
on `req.secure`, since setting it unconditionally would be wrong for any deployment still
serving plain HTTP.

**`robots.txt` and a dynamic `sitemap.xml`** — neither existed before. The sitemap is
generated from live data (published courses, published blog posts, trainer profiles), not
a static file that would drift from the real catalog; verified an unpublished course is
correctly excluded, not just that the file parses as valid XML.

## An honest limitation of this testing

The CSP was verified for correct syntax, for not breaking any existing route, and for
matching every domain reference found via static analysis. It was **not** verified against
real browser execution of the Paddle and PayPal SDKs, which may load additional
sub-resources at runtime from domains a static grep of the source code can't reveal (e.g. a
checkout iframe pulling from a different subdomain than the one in the initial script tag).
Curl can confirm the header is well-formed and the page loads — it cannot confirm a real
browser wouldn't report a CSP violation partway through an actual Paddle or PayPal checkout
flow. That would need real browser testing against real sandbox credentials, the same
category of gap already named for the payment integrations themselves.

## What Phase 9 still needs — named plainly, not implied as done

- **Accessibility audit**: a spot-check found only 2 occurrences of `aria-label`/`alt`
  across the view layer — a full audit (image alt text, ARIA labels on icon-only buttons,
  keyboard navigation, focus management in modals) has not been done.
- **README currency review**: the file exists but hasn't been checked against the current
  state of the app (Phases 1–8 added enormously to what a README should document).
- **Deployment documentation**: environment variable reference, production checklist, and
  monitoring/logging guidance beyond the error handler's console output.
- **A final, consolidated Configuration Inventory pass** confirming it's current against
  everything added since the last update.

## Full regression

Every public route, registration, admin login, and course creation confirmed working after
every change in this session.

## Confirmation

The error handler and CSP were both verified by deliberately constructing the failure case
each was built to prevent (a real thrown error; checking real external-domain usage) rather
than assumed correct from writing the code. The remaining Phase 9 items are stated as open,
not silently folded into "Phase 9 complete."
