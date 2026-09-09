# Verification Report — Trainer & Affiliate Read-Only, Own-Data-Only Access

## What was found and fixed

**A real gap**: the trainer dashboard included commission earnings from courses the
instructor doesn't teach — specifically, a sale on a *different* instructor's course that
this instructor personally referred via their own link (permitted under Phase 7's
documented "site-wide referral code" simplification). Even though the displayed earnings
table never showed course name, learner identity, or session details for that entry — just
an aggregated tier/rate/amount — the underlying data pull still crossed into another
trainer's course, which your requirement ("his own course and training session only, not
of any other trainer") rules out. Fixed: the trainer dashboard's registrations and earnings
are now strictly limited to courses this instructor actually teaches. A cross-course
referral this instructor generates is still correctly credited and paid out through the
real payout system (Phase 7) — it simply no longer appears on this strictly own-course
view.

## What was already correct

- **The affiliate dashboard** was already scoped correctly: registrations shown are
  filtered to exactly `referredById === this affiliate's id`, nothing else. Since affiliates
  aren't tied to any single course by design, their own referrals legitimately span
  multiple courses — that's their own data, not another affiliate's.
- **No CUD route exists for either role.** A full route-by-route audit of every trainer/
  affiliate endpoint confirmed only three kinds of routes exist: application submission
  (before the account is even active), login/logout (session management), and the single
  read-only dashboard `GET` per role. No route accepts a course edit, registration change,
  or any other mutation from a trainer or affiliate session.
- **The public trainer-profile page** (bio, courses taught) is intentionally public
  marketing content and carries no registration, earnings, or commission data — a separate,
  unrelated concern from the private dashboard.

## Verified directly, including the case most likely to reveal a leak

Built a genuine two-course scenario: Instructor A teaches Course A and separately refers a
sale to Course B (taught by someone else) using their own referral link. Confirmed
Instructor A's dashboard shows the Course A sale (`platform_sourced` tier) but *not* the
Course B referral — the fix holds under the exact condition it was designed for, not just
in the abstract.

**CUD audit, tested by attempting actual writes, not just reading the code**: a trainer
session and an affiliate session were both used to attempt creating a course and marking a
registration complete via the admin routes. Both were redirected (302, to admin login —
sessions for these roles carry no admin credential at all) rather than succeeding, and a
direct database check confirmed zero unauthorized records were actually created — not just
that the HTTP response looked like a rejection.

## A note on this testing session's process

Several early attempts to verify the trainer-dashboard fix appeared to fail — the
just-created instructor couldn't be found by a follow-up database query. Chased this down
rather than assume either "the fix is broken" or "the environment is flaky" without
evidence: added temporary server-side logging, which showed the instructor was reliably
being inserted every time. The actual cause was a bug in my own test script — the
application correctly lowercases email addresses on save (`email.toLowerCase()`), but
several of my test emails used mixed case (e.g., `instrA@test.com`), and my follow-up
lookup queries used that same mixed-case string, which never matched the lowercased stored
value. Once every test email was made consistently lowercase, the fix verification was
clean and reliable on every run. Noting this because it materially changes the story: this
was never an application defect or environmental instability, and it would have been wrong
to report it as either.

## Full regression

Every public route, registration and duplicate-blocking, admin course creation, and a
fresh affiliate application confirmed working after the fix.

## Confirmation

The trainer-dashboard fix was verified against the exact scenario it was built for (a
real cross-course referral), and the "no CUD" requirement was verified by attempting actual
writes and checking the database afterward — not by reading the route list and inferring
that no mutation exists.
