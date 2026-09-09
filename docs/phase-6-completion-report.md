# Phase 6 Completion Report — Learning & Certification

## What was implemented

**Course materials** (Section 24) — a genuinely new feature; nothing existed before this
phase. Admin upload, course-scoped through the same `requireCourseAccess` mechanism as
everything else. Stored **outside** `public/` entirely (unlike brochures, which are
deliberately public), so the only way to reach a file is through the download route, which
checks the requester has a real qualifying registration before ever touching the
filesystem.

**Certificates and digital badges** (Sections 17, 18): an admin "Mark Complete" action on a
confirmed registration issues a real, branded PDF certificate with a sequential
human-readable number (`CERT-2026-000001`), records `enrollment_progress` at 100%, and
generates the badge as a public verification page at `/verify/:id` — deliberately
reachable without login, since the entire point of a shareable credential is that anyone
who receives the link can confirm it's real.

**Multi-stage feedback** (Sections 14/15): purchase-stage and course-completion-stage
feedback prompts are now genuinely functional, not placeholder rows — a real prompt is
created at each trigger point (confirmed registration; marked complete), surfaced on the
learner's account page, and submitted through an access-controlled route.

## Master Prompt sections addressed
15 (partial — see deferrals), 17, 18, 24, per the Phased Implementation document's Phase 6
scope.

## A real gap from last session, fixed before starting this phase

The PayPal checkout page never actually existed — `checkout.ejs` unconditionally loaded
Paddle's SDK regardless of which provider was selected, so PayPal was structurally
unreachable by a real customer despite the server-side integration being real. Fixed by
adding a genuine conditional branch for each provider. Verified both branches render with
the correct SDK and order id, with no cross-contamination between them. The live PayPal
approval flow itself still can't be tested without real credentials — that limitation is
unchanged and remains honestly flagged, but the structural gap that made it *unreachable
regardless of credentials* is now closed.

## What was tested, and the result

- Course materials: not reachable via a guessed static path (404); correctly hidden from
  an unqualified learner on the course page and blocked from direct download (403); an
  anonymous visitor is redirected to log in; a learner with a confirmed registration sees
  and downloads the material with correct content.
- Certificate generation: the PDF was read back with a real parser and confirmed to
  contain the learner's name and course title (one apparent mismatch — the certificate
  number — was checked directly and confirmed to be a benign PDF-text-extraction spacing
  artifact around the hyphen, not missing content).
- The verify page renders correctly for a real certificate and 404s for a fake id.
- Certificate download: owner succeeds, a different learner is blocked (403).
- Marking a registration complete twice does not create a duplicate certificate.
- Multi-stage feedback: both stages' prompts appear correctly, submit correctly, reject an
  out-of-range rating (400), and are blocked (403) when a different learner attempts to
  submit someone else's prompt — confirmed the hijack attempt did not alter the data.
- Full regression across every phase after all of the above.

## A lesson from earlier phases applied proactively, not rediscovered

Given the same "table exists in the schema but was never registered in the CRUD layer"
mistake had already surfaced twice in this project, every new table this phase depended on
(`enrollment_progress`, `feedback`, `certificates`) was checked against the registry
*before* writing any code that used them, not after a crash revealed the gap. All three
were found missing and fixed up front.

## Deferred, explicitly

**Module-level feedback** is not implemented — it requires real course content management
(module CRUD) that doesn't exist anywhere in this app yet; the `modules` table exists in
the schema but nothing populates it. Building genuine module-stage feedback without real
modules to attach it to would mean either fabricating fake module data or building a
half-feature — neither is preferable to leaving this stage honestly unbuilt until course
content management itself exists. **CPD tracking** (`cpd_records`) is untouched — a
distinct, later concern tied to certification renewal cycles, not course completion
itself.

## Confirmation

Nothing in this phase uses mock data, a placeholder workflow, or a simulated result —
certificate generation, the verify page, and feedback submission were all exercised via
real HTTP requests against real data, including the negative cases (hijack attempts,
invalid ratings, unqualified access) that are the ones most likely to silently regress if
only the happy path gets checked.
