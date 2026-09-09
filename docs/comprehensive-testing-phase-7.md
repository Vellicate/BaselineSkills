# Comprehensive Testing Report — Phase 7 Surface Area

Scope: every new flow, path, corner case, and failure case Phase 7 introduced
(trainer/affiliate accounts, onboarding, referrals, commissions, payouts) — targeting what
hadn't been exercised yet, not re-confirming what already passed.

## Two real bugs found and fixed

**1. A rejected applicant was permanently locked out of ever reapplying.** The
re-application check blocked on *any* existing record with that email, regardless of
status — meaning fixing whatever got someone rejected and trying again was structurally
impossible. Confirmed exploitable: rejected an application, then confirmed a reapply
attempt with the same email failed with "already exists." Fixed by allowing reapplication
specifically when the existing record's status is `rejected` — the existing row is updated
(new password, new signed RoE, status reset to `pending`) rather than blocked, and rather
than creating a second row (which the email UNIQUE constraint wouldn't allow anyway).
Verified: reapplication now succeeds, status resets to pending, and exactly one row exists
for that email — not two.

**2. Trainer and affiliate login had no rate limiting or brute-force protection at all** —
unlike learner and admin login, which both use the failure-only tracker. Fixed by applying
the same `createLoginAttemptTracker` pattern used elsewhere: 10 failed attempts trigger a
429, verified directly with 10 wrong passwords followed by an 11th confirming the block.

## The core commission scenario that had never actually been tested

Every previous commission test used a single sale, well below the affiliate high-tier
threshold — meaning the tiered-rate logic itself (10% vs. 15%) had only ever been exercised
in the "always 10%" branch. This pass generated 7 real referred sales for one affiliate
within the same quarter: the first 6 (cumulative $458,490, under the $500,000 threshold)
correctly rated at 10%; the 7th (crossing the threshold at $534,905 cumulative) correctly
jumped to 15% — the exact threshold-crossing behavior, not asserted from reading the code.

## Verified, not assumed

- **Session isolation across all four account types**: a trainer session is correctly
  redirected away from the affiliate dashboard, the admin panel, and the learner account
  page, while still correctly reaching their own trainer dashboard.
- **`course_admin` is correctly blocked (403) from both payout generation and
  trainer/affiliate application review** — confirming these are deliberately
  super-admin-only, not an oversight in scoping.
- **The documented "site-wide referral code" simplification behaves exactly as
  documented**: an instructor referring a sale to a course they don't teach still
  correctly earns the 80% instructor-referred rate, not a lower or zero rate — this is the
  known, accepted behavior from Phase 7's report, confirmed rather than left unverified.

## Full regression

Every public route, duplicate-registration blocking, and the complete
onboarding/login/referral chain confirmed working together after both fixes.

## Confirmation

Both defects in this pass were found by deliberately constructing the specific scenario
each depends on (a genuine rejection-then-reapply attempt; genuine repeated failed logins;
genuine multi-sale threshold crossing) rather than inspecting the code and assuming the
happy-path tests already run were sufficient.
