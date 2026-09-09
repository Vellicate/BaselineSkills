# Configuration Audit Report — No Hardcoded Rules or Data

Scope: a systematic, grep-based sweep of the entire codebase — not a recollection of what
was built — confirming every business rule, threshold, and repeated value lives in
`config/business-rules.json`, per Master Prompt Section 6.

## Confirmed already clean

`lib/discounts.js` and `lib/commissions.js` — the two modules Section 6 is most directly
about — had zero hardcoded business values before this audit even started. Every discount
percentage, day threshold, and commission rate already read from config. The only literal
`100` appearing in either file is pure arithmetic (dividing a percentage by 100 to get a
fraction), not a business rule.

## Real gaps found and fixed

A code-wide grep for `windowMs:`, `maxAttempts:`, `fileSize:`, `length < [0-9]`, and
`minlength="[0-9]` surfaced three categories of genuinely duplicated, hardcoded values that
had accumulated across Phases 2–7 as each new login/application/upload flow was built
independently, each repeating the same numbers rather than sharing one source:

1. **Password minimum length (`8`)** — hardcoded identically in 8 places: `auth.js`
   (signup, set-password), `onboarding.js` (trainer and affiliate applications), and 4 view
   templates displaying the same number as a hint.
2. **Rate-limiting thresholds** — hardcoded in ~13 places: every login-attempt tracker
   (admin, learner, trainer, affiliate), and the registration, signup, onboarding-
   application, review, brochure-request, and contact/corporate-inquiry rate limiters.
3. **File upload size caps** — 15MB (brochures, signed RoE documents) and 100MB (course
   materials), hardcoded in 3 places.

All three categories are now consolidated into a new `security` section in
`config/business-rules.json`, and every one of the ~24 call sites above now reads from it
rather than repeating a literal.

## A mistake caught during the fix, not after

While writing the new config values, the contact/corporate-inquiry limiter's real max (15)
and the brochure-request limiter's real max (10) were initially assigned to the wrong
config keys — an easy transcription error given how similar the two limiters look. Caught
by cross-checking each new config value against the actual route code using it, not by
trusting the first draft, and corrected before anything shipped.

## Verified, not just asserted

Changed `PASSWORD_MIN_LENGTH` to `12` in the live configuration and confirmed — with zero
code changes — that both the displayed "12+ characters" hint on the signup page *and* the
actual server-side rejection of an 11-character password updated together, then confirmed
a 12-character password was accepted. This is the real test of "config-driven": a value
change taking effect everywhere it's used, in the same direction, without touching code.
The original values were restored afterward.

## Checked and confirmed as correctly *not* moved to config

- **PDF layout constants** in `lib/invoices.js`/`lib/certificates.js` (pixel coordinates,
  font sizes, hex colors) — checked specifically, not assumed. These are visual
  presentation, not business logic, and Section 6 doesn't ask for document layout to be
  externally configurable.
- **`DEFAULT_MAX_PARTICIPANTS_PER_SESSION`** remains unused in application code — but this
  was already documented back in Phase 4 as deliberate: no source document specifies a
  default session capacity, so none was invented, and admins set capacity explicitly per
  session instead. Re-confirmed this reasoning still holds rather than treating the unused
  value as a new defect.

## Full regression

Every public route, registration (plus duplicate-blocking), admin login and course
creation, and a fresh affiliate application all confirmed working correctly after every
change in this audit.

## Confirmation

This was a genuine code-wide search, not a recollection exercise — the three categories of
gap found here existed because each new feature across five phases independently
hardcoded the same class of value rather than sharing one source, which is exactly the
kind of drift a systematic grep catches and a mental review does not.
