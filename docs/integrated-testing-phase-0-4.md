# Integrated Testing Report — Phases 0 through 4

Scope: primary flow, edge conditions, alternate flows, and error conditions spanning
multiple phases together — specifically the combinations Phase 4's additions create with
everything built before it, not a re-run of each phase's own isolated tests.

## Primary flow — the fullest version yet, tested as one continuous path

Search for a course → view its detail page → admin adds a certification exam product to
it → an anonymous visitor registers *with the exam add-on selected* (never combined with
anonymous auto-account-creation before this pass) → confirmation email contains a working
set-password link → password set → logs in → account page shows the registration →
leaves a review. Every step confirmed via real requests and direct database checks:
learner auto-created with no password, registration's `learnerId` correctly linked, exam
correctly attached with its own discounted price, total charge equal to course + exam.

## Edge and alternate flows confirmed correct

- **On-Demand (non-date) sessions don't break discount calculation or crash the register
  page** — `daysUntil()` returns `null` for a non-parseable date string, and the discount
  correctly falls back to no early-bird discount rather than throwing.
- **Exam add-on at a genuine 61-day early-bird session** applies the *same* 15% rate to
  both course and exam independently — verified the exact cents on each ($850.00 and
  $170.00 from $1,000 and $200 respectively), not just that a discount was applied at all.
- **Duplicate-registration blocking is keyed correctly** — a second attempt with the exam
  checkbox *unchecked* this time (differing from the first, successful attempt) is still
  correctly blocked as a duplicate, confirming the check is keyed on email+course+session
  and not accidentally also keying on the exam selection.
- **Course-admin's positive case, not just the negative one**: an admin *assigned* to a
  course can add a certification exam product to it (302) — previous testing had only
  confirmed the *blocked* case for unassigned admins; this confirms the scoping mechanism
  correctly grants access too, not just denies it.

## Error conditions

- **CSRF protection covers the newest Phase 4 routes**, not just the ones that existed
  when the broader fix was applied last session: a cross-origin `/set-password` submission
  and a cross-origin certification-exam-product creation are both correctly blocked (403).
- **Set-password token reuse is correctly rejected**: using the same token a second time
  after it's already been consumed fails (400, "invalid or has expired"), confirming the
  token is actually cleared on use rather than remaining valid indefinitely.

## One real bug found and fixed: certification exam prices had no validation

A negative price (`-50`) was silently accepted and stored, which would have produced a
negative charge if that exam were ever added to a registration. Fixed with a straightforward
server-side check (must be a positive, finite number) before the insert — verified the
negative case is now rejected (redirects with an error, nothing stored) while a valid
positive price still succeeds normally.

## Full regression

Every public route, registration (plus the duplicate-check), admin login, and admin course
creation confirmed working after this fix, on top of the cumulative regression suites
already run at the end of every prior phase.

## Confirmation

Every check above was exercised against a real running server and real data — including
the negative/error cases (duplicate blocking, token reuse, cross-origin rejection, negative
price) that are the ones most likely to silently regress if only the happy path gets
re-tested after a change.
