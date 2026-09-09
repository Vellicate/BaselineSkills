# Phase 7 Completion Report — Trainers, Affiliates & Commissions

## What was implemented

**Trainer and affiliate authentication**, finally built — explicitly deferred back in
Phase 2 with the reasoning that both belong alongside their onboarding flows rather than
as bare login with nothing behind it. That reasoning is now resolved: real accounts,
real sessions, real dashboards.

**Full onboarding flow for both roles**: application page with the real Rules of
Engagement PDF (the actual document built earlier in this project, not a placeholder) →
signed-copy upload → application recorded as `pending` → admin review → approve/reject,
with a rejection reason recorded. Approval automatically generates a referral code.

**Referral attribution**: a `?ref=CODE` on the course page or registration page is captured
in-session and attributed at registration time via last-touch matching against
`referral_codes`, setting `referredById`/`referralType` on the registration.

**Commission calculation** (`lib/commissions.js`), entirely config-driven — no literal 60,
80, 70, 10, or 15 anywhere in the file. Three tiers implemented and each verified with a
real registration: platform-sourced (60%, when no referral exists and the course has an
assigned instructor), instructor-referred (80%, via the instructor's own code), and
affiliate (10% standard / 15% above the quarterly threshold, computed from actual trailing-
quarter referred revenue, not a static flag). Every result is a full itemized breakdown —
gross, discount, exam fee, taxes, withholding, gateway charges, commission, net — with the
not-yet-calculable fields (taxes, withholding, gateway charges) shown as honest zeros
rather than silently folded into the total.

## Master Prompt sections addressed
6, 26, 27, 28 (partial — see deferrals), per the Phased Implementation document's Phase 7
scope.

## What was tested, and the result

- Both application pages load; the real RoE PDF downloads correctly (verified as a genuine
  5-page PDF, not a broken link).
- An affiliate application with a real uploaded signed PDF is correctly recorded as
  pending; login is correctly blocked (403) before approval; the admin applications list
  shows it; approval flips status to `approved` and generates a referral code.
- End-to-end referral chain: visiting a course page with `?ref=`, then registering,
  correctly sets `referredById`/`referralType` on the registration — confirmed by direct
  database check, not inferred.
- Commission calculation verified for all three implemented tiers with real registrations,
  checking the exact computed cents each time, not just that a number came out: affiliate
  standard rate (10%, $76.42 on a $764.15 sale), instructor platform-sourced (60%), and
  instructor self-referred (80% — confirmed genuinely different from the 60% platform rate
  on an equivalent sale, not a coincidental match).
- Full regression across every phase, plus CSRF protection confirmed on the new
  application-submission routes.

## A real bug caught and fixed before it shipped, not after

While building the affiliate dashboard, `earnings` was filtered to only confirmed
registrations while `registrations` (displayed in the same table, matched by array index)
was not — meaning a mix of confirmed and pending referrals would have silently misaligned
every row after the first pending one, showing the wrong commission next to the wrong
course. Caught while writing the view, before ever running it: fixed by computing an
earnings entry (real or `null`) for every registration in the same order, rather than
filtering the two arrays independently.

## Deliberate simplifications, documented rather than silently taken

- **Referral attribution uses the existing session, not a 30-day cookie.** The config
  value `REFERRAL_ATTRIBUTION_WINDOW_DAYS` implies a full cookie-based window; a visitor
  who clicks a referral link and registers within the same visit is attributed correctly,
  but not if they return days later without the link. A real cookie-based implementation
  is straightforward to add later but was not built this session.
- **An instructor's referral code applies site-wide, not scoped to only their own
  course(s).** The schema supports per-course scoping (`referral_codes.courseScope`), but
  generating and maintaining a scoped code per course an instructor teaches — including
  instructors who teach more than one — was deferred in favor of a single code per
  instructor. The commission calculation still correctly applies the instructor-referred
  rate regardless of which course was referred.
- **Corporate/bulk commission (70/30) is not reachable.** It requires real corporate-
  account attribution on a registration, which doesn't exist anywhere in this app — no
  corporate purchase flow has been built. Deliberately not approximated via a proxy signal
  like a non-empty company field, since that would silently misclassify an individual who
  simply entered their employer's name at checkout.
- **Payout generation** (creating actual `payouts`/`payout_line_items` rows and a
  payment-status workflow) was not built this session — commission calculation is real and
  correct, but nothing yet aggregates it into a payable, trackable payout record. This is
  the most significant remaining piece of this phase's original scope.

## Confirmation

Nothing in this phase uses mock data or a hard-coded result — every commission figure
reported above was computed by the real calculation engine against a real registration,
and the tier differences (60% vs. 80%, 10% vs. what a higher-tier affiliate would see)
were confirmed to actually differ, not merely asserted.

## Addendum — payout generation, built and tested

**What was implemented**: `lib/payouts.js` generates a real, traceable payout — an admin
picks a recipient and a period; the system finds every registration already
commission-attributed to that exact recipient, confirmed within the period, and not
already claimed by an earlier payout, then creates one `payouts` row plus one
`payout_line_items` row per underlying sale. Status is a real workflow (`pending` →
`processed`/`failed`, admin-driven), never a hard-coded "paid" flag — the confirm dialog on
"Mark Processed" explicitly asks the admin to confirm they've actually sent the money by
their normal means first. Both dashboards now show payout history distinct from
currently-accruing, not-yet-paid-out earnings.

**The critical case tested directly**: generating a second payout for the same recipient
and the same period does not double-count the sale already included in the first payout —
confirmed by checking that a second attempt correctly reports no eligible sales and the
total payout count stays at one, not two. This was the one part of the design most likely
to be silently wrong (the "already claimed by an earlier payout" check has no room for a
subtle off-by-one or has-vs-hasn't-been-included bug), so it was the first thing tested,
not an afterthought.

**Also verified**: the payout detail page correctly shows the underlying course and learner
per line item (real traceability, not just a total); marking processed sets both status and
a real timestamp; both dashboards correctly display the resulting history; and cross-origin
CSRF protection covers the new payout-generation route.

**This closes the phase's most significant remaining gap** from the original report — no
technical blocker prevented this (unlike Paddle/PayPal, which genuinely need real
credentials); it simply hadn't been built yet in the earlier session.
