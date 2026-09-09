# Phase 4 Completion Report — Registration & Checkout

## What was implemented

**Config-driven early-bird discounts** (Sections 6, 10): `lib/discounts.js` reads every
threshold and percentage from `config/business-rules.json` — no literal `60`, `30`, or
discount percentage appears in the calculation code. Combines with a course's own flat
`discountPercent` (takes the larger of the two, capped at `MAX_COMBINED_DISCOUNT_PERCENT`)
rather than stacking them. Wired into the registration form, the actual charge, and the
Paddle transaction amount — the old flat-only `finalPriceCents` was removed as dead code
once nothing called it anymore. The registration form now shows the discount tier name,
the deadline date, and days remaining, per Section 10's display requirements.

**Anonymous registration auto-creates a real learner profile** (Section 12): an anonymous
visitor gets a real `learners` row (no password set yet) rather than a permanently-null
`learnerId`. If an account for that email already exists, the registration links to it
instead of erroring against the email UNIQUE constraint. A secure, time-limited
set-password link is included in the confirmation email; visiting it lets them set a real
password and log in normally from then on.

**Certification exams as a separate purchasable product** (Section 11): a new
`certification_exams` table — not in the original 47-table design, since `exam_bookings`
only recorded individual bookings, not the catalog of exams available to book in the first
place. Admin-managed per course, course-scoped through the same access-control mechanism as
everything else in Phase 2/3. Displayed as an optional add-on during registration with its
own discounted price, using the identical discount rate as the course (not a separate
calculation), with a clear course-fee / exam-fee / total breakdown.

## Master Prompt sections addressed
6, 10, 11, 12, per the Phased Implementation document's Phase 4 scope.

## What was tested, and the result

- **The exact three cases the master prompt specifies**: 61, 45, and 15 days out, producing
  exactly 15%, 10%, and 0% — verified directly against `lib/discounts.js` and through the
  full HTTP registration flow, confirming the displayed price and the actual amount charged
  both matched.
- **Genuinely config-driven, not hardcoded**: changed the discount percentages in the
  config file, confirmed the same test dates produced different results with no code
  change, then restored the original values and confirmed behavior reverted.
- Anonymous registration creates a real learner account with no password; the confirmation
  email contains a working set-password link; setting a password lets them log in normally
  afterward; an expired/invalid token is correctly rejected (400); a second anonymous
  registration with the same email correctly links to the existing account rather than
  erroring.
- Certification exam add-on: registering without selecting it charges the course price
  only with no exam fields set; registering with it selected charges course + exam
  (verified the exact cents match: course and exam both discounted at the same 15% rate);
  course-scoping blocks an unassigned `course_admin` from adding an exam product (403).
- Full regression across every public route, admin login, admin course creation,
  registration, and learner signup/account after all changes in this session.

## A real, unrelated bug found and fixed while testing this phase

**`lib/mailer.js` was writing every email log directly to a flat JSON file, completely
bypassing the SQLite database** — a leftover from Phase 1's migration that was never
closed. The `emailLog` table had been frozen at whatever it contained during the original
one-time migration; every real email since then went somewhere the database (and any
future admin reporting built on it) couldn't see. Found by checking that the new
set-password link actually appeared in a logged email — the check came back empty, which
led to tracing the actual write path rather than assuming the log was simply late. Fixed by
routing `logToFile` through the same `store.insert` every other part of this app uses.
Verified: registration now logs both the learner and admin emails to the database
correctly, the old flat file is no longer written to, and the contact form and corporate
inquiry emails (unrelated flows using the same mailer) still log correctly too.

## Deferred, explicitly

Shopping cart / multi-course checkout was not part of this phase's own scope (the Phase 4
deliverables describe a single course plus optional exam, not a multi-item cart) and
remains a separate, later concern. Tax/VAT display on the registration page (mentioned
generally in Section 13, Invoices) is not yet implemented — invoices themselves are Phase 5
scope.

## Confirmation

Nothing in this phase uses mock data, a placeholder workflow, or a simulated result — the
discount tiers, the auto-created account, the set-password flow, and the exam add-on
pricing were all exercised against a real running server and real data, including the
config-change test, which specifically rules out a hardcoded result that only looked
config-driven.
