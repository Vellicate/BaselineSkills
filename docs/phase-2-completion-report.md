# Phase 2 Completion Report — Authentication & Roles (partial — see deferrals below)

## What was implemented
- `lib/auth.js`: password hashing (bcryptjs, synchronous throughout — see "assumptions"),
  admin bootstrap, and role-based authorization middleware (`requireAdmin`,
  `requireSuperAdmin`, `requireCourseAccess`, `requireLearner`).
- **Real admin accounts**, replacing the single env-var password check: backed by the
  `admins` table, bcrypt-hashed, with `super_admin`/`course_admin` roles. A bootstrap step
  auto-creates one `super_admin` from `ADMIN_PASSWORD` on first boot, so an existing
  deployment isn't locked out by this change.
- **Course-scoped authorization enforced**, not just defined: `course_admin` accounts are
  blocked (403) from editing/deleting a course they aren't assigned to via
  `admin_course_assignments`, and correctly allowed once assigned. `super_admin` always
  passes.
- **Learner (student) authentication**: signup, login, logout, and a real protected
  `/account` page showing the learner's own registrations (matched by email).

## Master Prompt sections addressed
7 (User Roles) — partially; see deferrals.

## What was tested, and the result
All of the following were verified via real HTTP requests and direct database checks, not
inferred from reading the code:
- Admin bootstrap creates exactly one account on first boot; login with that password
  succeeds.
- Learner signup creates a real row, sets a real session, and the resulting `/account` page
  actually renders that learner's name and their real registrations.
- `/account` without a session redirects rather than serving the page.
- A duplicate signup with an already-used email is rejected.
- **Course-scoping, the highest-risk part of this phase**: a `course_admin` is blocked
  (403) from a course they aren't assigned to, allowed (200) once assigned via
  `admin_course_assignments`, and separately confirmed still blocked (403) from a
  *different*, still-unassigned course — ruling out a too-permissive check that happened
  to pass the first test for the wrong reason.
- Full regression: every public route, registration, and existing admin CRUD
  (courses/trainers/blogs/resources) still work after these changes.

## A real bug found and fixed during this work
`admin_course_assignments` had a SQL table (from Phase 1) but was never added to the
generic CRUD layer's table registry — meaning the authorization check that depends on it
was crashing (500) rather than correctly returning 403 or 200. Found by testing the actual
scoping behavior, not by reading the code and assuming it worked.

## Assumptions made, and why
- **bcryptjs's synchronous API, not the async one.** The rest of this app's data layer
  (better-sqlite3) is synchronous; an async bootstrap step at the top of `app.js` created a
  real race condition (a login could arrive before the bootstrap admin was created). Fixed
  by using the sync API throughout rather than requiring every call site to chain promises
  correctly.
- **The login form stays password-only** (no username field), matching the existing UX —
  the backend checks the submitted password against every stored admin hash. This is
  correct and sufficient for the realistically small number of admin accounts this business
  will have; it would need revisiting only if admin accounts numbered in the hundreds.

## Deferred, explicitly, not silently
**Trainer (instructor) and Affiliate login are not built in this phase**, despite Section 7
listing them as "at minimum" required roles. Reasoning: both are naturally introduced
alongside their onboarding flows (application, Rules of Engagement, admin approval) in
Phase 7 — building bare login for an account type with nothing behind it yet would mean
either shipping an empty dashboard or building placeholder screens, which Section 3
explicitly prohibits. This is a deviation from strict phase completeness, flagged per
Section 39 (Handling Ambiguity) rather than silently under-delivered.

## A finding from Phase 0, addressed here
The three duplicate rate-limiting/CSRF implementations are **not consolidated in this
session** — `admin.js`'s inline `verifyOrigin` is confirmed still the one actually
protecting admin routes (course-scoping was tested through it), and it works correctly.
Consolidating away `lib/security.js` (dead code) and reconciling it with `rate-limiter.js`
remains open, best done as part of Phase 9's security pass, or sooner if you'd like it
prioritized.

## Addendum — duplicate registrations fixed and tested
A thorough test pass after this report was first written surfaced one gap: duplicate
registrations were silently allowed. Fixed in `routes/registration.js` — a registration is
now blocked (400, with a clear message) only when the same email registers again for the
same course *and* the same specific session; a different session of the same course, or a
different course entirely, is still allowed, since those are genuinely different
registrations, not accidental resubmissions. The email match is case-insensitive. Verified
directly: exact duplicate blocked, same-email-different-case also blocked, different
session allowed, different course allowed, and a final database check confirming exactly
the expected three legitimate rows were created (not five) after five attempts. A full
regression pass afterward confirmed the normal registration and learner-signup flows are
unaffected.

## Second addendum — a cross-phase inconsistency found and fixed while checking the first
Cross-checking the duplicate-registration fix against the other phases surfaced a real,
pre-existing gap: `registrations.learnerId` (a real column since Phase 1, intended for
exactly this relationship) was never being set, even for a learner who was logged in at
the moment they registered — Phase 2's own `/account` page was working around this by
matching on email string alone, not the FK relationship the schema was actually designed
around. Left alone, every later phase keyed on `learnerId` (certificates, enrollment
progress, reviews, wishlist — effectively all of Domain C) would have inherited the same
workaround.

Fixed narrowly, without scope-creeping into Phase 4's full "auto-create a profile for an
anonymous registrant" requirement: `routes/registration.js` now sets `learnerId` from
`req.session.learnerId` whenever a registration is submitted by an already-logged-in
learner. Anonymous registrations correctly remain `learnerId: null`, exactly as before,
until Phase 4 builds the auto-creation flow. `/account` now matches by `learnerId` first,
falling back to email — so registrations made anonymously before this fix (or by a visitor
who registers before creating an account) still surface correctly, rather than silently
disappearing from the account they clearly belong to.

Verified: a logged-in learner's new registration gets the correct `learnerId`; an anonymous
registration still gets `null`; the account page shows the correctly-linked registration;
an anonymous-then-later-signup registration still shows via the email fallback; and the
duplicate-check from the first addendum still works correctly alongside this change. Full
regression re-confirmed every public route, admin login, and admin course creation
afterward.

## Third addendum — a further thorough edge-case/negative-case pass, four real bugs found and fixed

**1. Course-scoping was far less complete than it appeared.** `requireCourseAccess` was only
wired into 3 of the routes that should have it. Confirmed exploitable: a `course_admin`
with zero assigned courses could toggle-publish *any* course, create blog posts, and view
all registrations/trainers — directly contradicting Section 7's definition of this role
("without necessarily having unrestricted system-administrator privileges"). Fixed:
`/courses/:id/toggle-published` now requires course access, matching the pattern already
used for edit/delete. `blogs` and `resources` — general site content with no course-scoping
concept that applies to them — are now restricted to `super_admin` outright, rather than
left open to any admin. **Not fully resolved**: trainers, registrations, inquiries, and the
dashboard are still open to any admin regardless of role. Properly scoping these to "related
to a course_admin's assigned courses" needs real filtering logic (which trainers teach
their courses, which registrations belong to their courses) that doesn't exist yet — rather
than rush an untested filter or block course_admins from their own post-login landing page,
this is flagged explicitly as remaining work, not silently left broken.

**2. A course with no scheduled sessions crashed the course detail page (500).** Root cause:
several of the courses table's JSON array fields (`deliveryModes`, `outcomes`, `audience`)
come back as `null` — not `[]` — when a course is created any way other than through the
admin form's own defaulting logic (a raw insert, a future import path). The view called
`.join()`/`.forEach()` on them with no guard. Fixed at the data layer, not by patching each
view call: these fields now always come back as `[]` when null. Deliberately scoped narrowly
— only fields explicitly marked as true arrays get this treatment, not every JSON field in
general, since a future nullable JSON blob (e.g. `feedback.structuredAnswers`) genuinely
should stay `null`, and `[]` is truthy in JS, which would silently change "no data" into
"empty data" if applied blindly.

**3. The login rate limiter could lock out a legitimate admin or learner who mistyped their
own password.** Confirmed: 10 wrong attempts followed by the *correct* password still
returned 429. Root cause: the generic rate limiter counts every attempt, not just failures.
Fixed by finally putting `lib/security.js`'s `createLoginAttemptTracker` to use (flagged as
dead code back in Phase 0) — it counts only failures and clears on success. Applied to both
admin and learner login. Verified: 9 wrong attempts then the correct password now succeeds
(302, not 429); 10 genuinely wrong attempts still correctly blocks the 11th (429) — brute-
force protection is preserved, not weakened.

**4. Negative/edge cases confirmed working correctly, no fix needed**: CSRF actually blocks
a genuinely different-origin request (403) and a missing-origin request (403), not just
"allows the correct origin" — both checked, not assumed. SQL injection attempts in email and
name fields (including a literal `DROP TABLE` string) are stored as harmless text, not
executed — confirmed the `learners` table still exists with data intact afterward. Session
cross-contamination is correctly prevented in both directions (an admin session can't reach
`/account`; a learner session can't reach `/admin`). Password length validation correctly
rejects exactly 7 characters and accepts exactly 8, matching the documented minimum.

A full regression pass after all four fixes confirmed every public route, registration
(including the duplicate-check from the prior addendum), admin login and course creation,
and learner signup/account all still work correctly together.

## Confirmation
Nothing in this phase uses mock data, a placeholder workflow, or a simulated result. Every
behavior described above — including the negative cases (blocked access, rejected
duplicate signup) — was exercised against a real running server, not asserted from reading
the code.
