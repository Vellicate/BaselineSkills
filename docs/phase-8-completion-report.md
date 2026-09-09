# Phase 8 Completion Report — Admin & Reports

## What was implemented

**Course-administrator scoping, finally resolved** — carried forward as an explicitly open
gap since Phase 2, flagged again in every subsequent phase's report. `auth.visibleCourseIdsFor(req)`
returns `null` (no restriction) for a `super_admin`, or the exact list of assigned course ids
for a `course_admin`, via `admin_course_assignments`. Applied throughout: the dashboard,
the registrations list and its CSV export, and the new feedback report all now show a
`course_admin` only their assigned courses' data — verified with a genuinely mixed dataset
(two different courses, two different learners), not just a single-course scenario that
couldn't reveal a leak.

**The dashboard rebuilt** to reflect Phases 3–7, which didn't exist when it was first
built: certification exams offered, certificates issued, feedback submitted-vs-prompted,
plus (super_admin only) total commissions owed, approved trainer/affiliate counts, and
pending payouts. The financial/HR metrics are deliberately not shown to a `course_admin` at
all, consistent with payout generation and application review already being
super-admin-only from Phase 7 — not an oversight, the same boundary applied consistently.

**A feedback report, which didn't exist as an admin-facing view at all before this phase**
— feedback was only ever created by the app (Phase 6), never surfaced for an admin to
actually read. Now filterable by course and stage, with an aggregate average rating and
CSV export, both scoped the same way as registrations.

**Registration report completed against Section 22's actual field list** — `phone` and
`address` didn't exist anywhere in the registration flow before this phase (not in the
schema, not on the form); added to both, and to the CSV export alongside the
previously-missing "certification exam purchased" field. Filtering by course and status
added to both the on-screen list and the export, using the same query parameters for
consistency.

## Master Prompt sections addressed
22, 23, 30, per the Phased Implementation document's Phase 8 scope.

## What was tested, and the result

- Super_admin dashboard shows every new metric card, including the financial/HR ones.
- Phone and address are genuinely captured at registration and appear correctly in the CSV
  export (not just added to the schema and left unpopulated).
- **The core scoping requirement, tested with a real mixed dataset**: registered two
  different learners for two different courses, assigned a `course_admin` to only one of
  them, and confirmed the dashboard, registrations list, CSV export, and feedback report
  all show *only* the assigned course's data — the other course's learner was confirmed
  absent from each, not merely "not specifically checked for."
- Inquiries export correctly blocked (403) for a `course_admin`, consistent with inquiries
  having no course to scope them by.
- Full regression across every phase after all changes.

## Confirmation

The scoping behavior — this phase's central requirement — was verified by actually
constructing a scenario where a leak would be visible (two courses, two learners, one
scoped admin) rather than testing with only one course in the system, which would have
made a scoping bug indistinguishable from correct behavior.

## Addendum — trainers-list scoping gap closed

Following the "thorough testing" pass, the trainers-management gap named as
out-of-Phase-8-scope was closed: the list now shows a `course_admin` only trainers who
teach at least one of their assigned courses (trainers aren't assigned directly — visibility
is derived through the courses they teach, the same relationship `admin_course_assignments`
already encodes). Creating a brand-new trainer profile (not yet tied to any course) remains
super-admin-only, consistent with the pattern already established for materials, exam
products, and FAQs. Editing and deleting are scoped to the same "teaches a visible course"
relationship.

Verified directly: a `course_admin` assigned to one course sees only the trainer teaching
that course, not others; direct-URL attempts to create a new trainer or edit/delete an
inaccessible one are blocked (403) — including confirming a blocked edit attempt did not
actually change the target trainer's data; the admin's own accessible trainer can still be
edited successfully. Super_admin's full trainer CRUD confirmed unaffected.
