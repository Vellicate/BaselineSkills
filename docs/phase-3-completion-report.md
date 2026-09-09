# Phase 3 Completion Report — Marketplace & Courses (partial — see deferrals below)

## What was implemented
- **Course levels**: `level` (Beginner/Intermediate/Expert) added to the admin course form
  and captured on save; displayed on course cards and used as a real filter.
- **Course images**: `imageUrl` added to the admin form and displayed on course cards.
- **Real search & multi-facet filtering** on `/courses`: free-text search (title/summary),
  level, delivery format, and max price — replacing the category-only filter that existed
  before. Every non-empty search is logged to `search_logs`, closing part of the
  supply/demand reporting gap from the Gap Analysis.
- **FAQ management** (Master Prompt Section 19): a real `faqs` table — not in the original
  47-table design, added here since a text blob can't support reorder/publish state
  cleanly. Full create/publish/unpublish/delete from the course edit page, rendered as an
  accordion on the public course page, scoped to course_admins' assigned courses via the
  same `requireCourseAccess` mechanism as course editing.
- **Course detail page reconciled further**: "Related Courses" renamed to "Courses to take
  after this one" per the reconciled Marketplace Pages structure, now preferring explicit
  `course_sequences` data over same-category matching when it exists. A Reviews section
  (average rating, count, individual reviews) added ahead of FAQ, matching the reconciled
  order.

## Master Prompt sections addressed
8 (Course and Training Management — levels), 9 (partial), 19 (FAQs), in scope from the
Phased Implementation document's Phase 3.

## What was tested, and the result
- Course creation with level + image via the real admin form; both fields confirmed stored
  and displayed correctly.
- Filtering by level correctly includes/excludes courses; text search finds matches and
  shows a proper empty state for no results; price filter correctly excludes courses above
  the threshold; combined filters work together.
- Search logging confirmed via direct database check.
- FAQ: added, displayed on the public page, unpublished (confirmed it disappears from the
  public page while staying in the admin list), deleted (confirmed removed from the
  database) — all via real HTTP requests, not code review.
- FAQ management correctly enforces course-scoping: an unassigned `course_admin` is blocked
  (403) from adding a FAQ to a course they don't manage.
- Full regression: search+filter combined, registration, learner signup/account, and every
  existing public route all still work after these changes.

## Two real bugs found and fixed during this work
1. **The exact same class of bug as Phase 2's `admin_course_assignments` miss, happened
   again**: `course_sequences` had a real SQL table but was never registered in the generic
   CRUD layer, so the new "courses to take after" logic crashed the public course page
   (500) the moment it ran. Given this is the second time this exact mistake has happened,
   I did a full systematic check this time — cross-referencing every SQL table against the
   CRUD registry, and separately confirming every table actually called anywhere in the
   current codebase resolves to a registered key. Both checks are now clean; the second one
   specifically rules out any other silent instance of this same bug.
2. Not a new bug, but confirmed as part of the above: the earlier `admin_course_assignments`
   fix remains intact — this check would have caught a regression there too.

## Deferred within this phase, explicitly
This is a large phase; the following Section 3-relevant deliverables were not attempted in
this session and remain open, not silently dropped:
- **Public trainer profile pages** — course pages still link out to an external profile URL
  (LinkedIn, etc.), not an internal `/trainers/:id` page.
- **Review submission** — display now exists (average, count, list), but there is no route
  yet for a learner to actually submit a review, and no enforcement of "verified purchase"
  (a confirmed registration) at submission time.
- **SEO fundamentals** (meta descriptions, structured data) — not addressed this session.
- Course-scoping for trainers/registrations/inquiries/dashboard, carried forward from the
  Phase 2 report, remains open.

## Confirmation
Nothing in this phase uses mock data, a placeholder workflow, or a simulated result — FAQ
publish state, search filtering, and course-sequence lookups were all exercised against a
real running server and real data, including the negative case (course-scoping still
correctly blocking an unassigned course_admin from the new FAQ routes).

## Addendum — the remaining Phase 3 deliverables, completed and tested

**Public trainer profile pages** (`/trainers/:id`): a real page showing bio, photo, and every
published course that trainer teaches, linked from course detail pages (replacing the
external-URL-only link; the external LinkedIn-style link is kept as a secondary "Connect"
button, not removed). Tested: renders correctly with real data, and a nonexistent trainer ID
correctly 404s rather than crashing.

**Review submission**, restricted to verified purchase: a learner can only submit a review
if they have a `confirmed` or `invoice_pending` registration for that specific course —
`pending_payment` (an abandoned checkout) does not qualify. One review per learner per
course, enforced server-side. Tested: a learner with no registration is blocked (403); a
learner with a qualifying registration succeeds (302); the same learner attempting a second
review is blocked (400); an out-of-range rating (99) is rejected (400); the submitted review
correctly appears on the public page with the correct recalculated average. Rating
distribution (a per-star breakdown, not just the average) was added to the display at the
same time, closing the last part of Section 16's requirement.

**FAQ reordering**: move-up/move-down actions that swap the `order` value with the adjacent
FAQ, scoped through the same course-access check as the rest of FAQ management. Tested
directly against the database — confirmed two FAQs' positions actually swap.

**SEO fundamentals**: a real meta description on every page (course-specific on course
pages, a sensible site-wide default elsewhere), a canonical URL tag driven by the actual
current path, and Schema.org `Course` structured data (including `CourseInstance` entries
per session, and `AggregateRating` once reviews exist) on course detail pages. Verified the
structured data is valid, well-formed JSON — my first check used a grep pattern that assumed
spaces after colons that `JSON.stringify` doesn't add by default, which looked like a
failure at first; checking the raw output directly confirmed the actual data was correct
all along, not a real bug.

A full regression pass after all of the above confirmed every existing public route,
combined search/filtering, registration (including the duplicate-check), admin login, and
admin course creation all still work together.

**Still carried forward, genuinely unaddressed**: course-scoping for
trainers/registrations/inquiries/dashboard remains open from Phase 2, and the full
Marketplace Pages document's remaining pages (Become an Instructor, Become an Affiliate,
Community, Certification Guide, Pricing & How It Works) belong to later phases (7 and
beyond) per the phased implementation plan, not this one.
