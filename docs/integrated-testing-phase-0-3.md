# Integrated Testing Report — Phases 0 through 3

Scope: end-to-end flows spanning multiple phases together, not re-confirming what each
phase's own report already tested in isolation.

## One real, significant bug found and fixed: no CSRF protection anywhere in `routes/public.js`

`admin.js` has always had origin verification; `public.js` — registration, contact,
corporate inquiry, brochure requests, and every Phase 3 addition (review submission,
learner signup/login) — never did. This predates Phase 3, but Phase 3's review submission
made it concretely dangerous for the first time: since reviews act on an *authenticated
learner session*, a malicious site could have tricked a logged-in learner's browser into
submitting a fake review — including a damaging one — without their knowledge.

**Fixed at the root, not per-route**: `lib/security.js`'s `requireSameOrgin` now exempts
GET/HEAD internally (matching the safety behavior `admin.js`'s own inline version already
had), making it safe to apply via `router.use()` across an entire router rather than
wiring it into each route individually. Applied to `public.js`, `auth.js`, and
`registration.js`.

**Verified, not assumed**: every ordinary GET page still loads correctly; every legitimate
same-origin action (signup, registration, review) still succeeds; and cross-origin attempts
are now blocked (403) on signup, registration, the contact form, and — the specific case
that mattered most — a review submission using a real, valid logged-in session.

## Cross-phase behaviors confirmed correct (not bugs, but worth having tested rather than assumed)

- **Unpublished courses can't be reviewed even without an explicit check in the review
  route**, because registration itself requires `published`, and review submission
  requires a real registration — the dependency chain closes the gap on its own. Traced
  directly rather than left as a theoretical concern.
- **Cascade deletion behaves exactly as designed**: deleting a course cascades to its FAQs
  and reviews (meaningless without the course), while registrations survive with `courseId`
  set to `null` and `courseTitle` preserved as a historical snapshot — matching the
  principle documented in the Database Design's cross-cutting notes.
- **The anonymous-registration-then-later-signup case works for reviews, not just the
  account page**: a learner who registered before creating an account can still review that
  course once they sign up, via the same email-fallback matching `/account` already uses.

## One additional gap found and fixed: no rate limit on review submission

Lower severity than the CSRF gap, given review submission already requires authentication,
a real qualifying registration, and allows only one review per learner per course — but an
attacker scripting many accounts and registrations could still spam reviews. Added a
per-IP limit (10/hour), consistent with the rate limiting already applied to registration
and signup.

## Full end-to-end primary flow, tested as one continuous path

Search/filter a course → view its detail page (FAQs, trainer, reviews all rendering) →
create an account → register while logged in (confirmed `learnerId` set correctly) →
attempt a duplicate registration (blocked, 400) → leave a review (accepted, verified
purchase) → view the account page (registration correctly shown via the `learnerId` link)
→ the review now visible publicly with the correct rating → a super_admin adds a FAQ to
the same course, correctly permitted. Every step confirmed via real HTTP requests and
direct database checks, not inferred from any single phase's report in isolation.

## Full regression

Every public route, admin login, and admin course creation confirmed working after all
fixes in this session, on top of the full regression suites already run at the end of
Phases 1 through 3.

## Confirmation

Nothing in this testing pass relied on code review alone where a real request could
verify it — including the negative cases (cross-origin rejection, duplicate registration,
duplicate review, out-of-range rating) that are easy to get wrong silently if only the
positive path is checked.
