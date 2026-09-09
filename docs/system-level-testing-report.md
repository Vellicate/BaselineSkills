# System-Level Testing Report — Full System

Scope: end-to-end verification across the complete system as it now stands, with
particular focus on intersections between the newest additions (certification bodies,
resource pages, branding) and the established core (registration, payments, scoping) —
the seams most likely to hide something a phase-by-phase test wouldn't catch.

## One real bug found and fixed

**Courses never received a `createdAt` or `updatedAt` timestamp when created or edited
through the admin panel.** The columns existed in the schema but `courseFromForm` never
populated them — meaning the sitemap's `lastmod` for every admin-created course silently
fell back to "today," never reflecting when it was actually created or last changed. Fixed
by setting `createdAt` once (preserved across every subsequent edit) and refreshing
`updatedAt` on every save. Verified directly: a newly created course has matching
`createdAt`/`updatedAt`; after editing it, `createdAt` is unchanged and `updatedAt` has
moved forward — not just that the fields exist, but that they behave correctly in both
directions.

## Two false alarms, investigated and correctly dismissed rather than assumed either way

Both surfaced from a keyword-based check flagging something that looked wrong at first
glance — worth documenting precisely how each was resolved, since accepting either at face
value (as a real bug, or dismissing without checking) would have been a mistake in
opposite directions.

- A newly created course with no certification-body mapping showed the word "Accredited"
  on its page, which looked like the certification-link feature firing when it shouldn't.
  Traced to the exact line: it was the sitewide Organization schema's generic description
  ("Accredited training and certification marketplace...") present on every page — nothing
  to do with the per-course certification link, which correctly does not render, confirmed
  by checking for the actual `certifications/` link markup and finding zero occurrences.
- This is the same category of false positive as an earlier session's "CPRE appearing on
  the IIBA certification page," which turned out to be the shared "Talk to Expert" modal's
  dropdown text, not a real cross-contamination bug.

## Verified across the full system

- **Complete mega-flow in one continuous session**: signup, registration with phone/
  address, a genuine signed-webhook payment confirmation, invoice generation, admin
  marking the course complete, certificate issuance, review submission — and, in the same
  session, the new resource listing, a resource detail page, and a certification body page
  all loading correctly alongside it.
- **Sitemap**: 36 total URLs, all unique (zero duplicates), with exact expected counts per
  content type (17 courses, 4 certification bodies, 6 real on-site resources).
- **Every major route across the whole site** — public marketing pages, the new resource
  and certification pages, learner and admin auth, trainer/affiliate applications and
  login, `robots.txt`, `sitemap.xml` — all returned correctly, plus registration,
  duplicate-blocking, admin course creation, admin resource creation, and a fresh affiliate
  application all confirmed working in the same pass.

## Confirmation

The one real defect in this pass was found by checking a specific, plausible operational
gap (does ongoing admin editing actually populate the fields the SEO work depends on) —
not by re-running old test scripts. Both false alarms were resolved by tracing to the exact
source line rather than either reported as new bugs or waved away, which is the same
standard applied to every other finding across this project.
