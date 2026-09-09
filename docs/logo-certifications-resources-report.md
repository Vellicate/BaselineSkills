# Implementation Report — Logo, Certification Body Pages, Resource Detail Pages

## Item 9 — Actual logo image in the header

Replaced the inline SVG bar-chart icon with the real uploaded logo mark image. Kept
"Baseline"/"Skills" as real, separately-styled text rather than baking the whole wordmark
into a raster image — real text stays crisp at any resolution, remains accessible to
screen readers, and preserves the existing hover/click animation the brand button already
has. The icon is marked `alt=""` (decorative) since the parent link already carries
`aria-label="Baseline Skills Home"` — avoids a screen reader announcing the same thing
twice. Verified rendered correctly across the desktop nav; the footer's plain-text logo
was deliberately left as-is, since the wordmark's dark teal text wouldn't contrast against
the footer's dark background — using it there would need a reversed/white version of the
mark that wasn't supplied.

## Item 6 — Certification body landing pages

Built genuine landing pages for the four certifying bodies actually represented in the
course catalog — IREB, IIBA, INCOSE, and Automotive & Functional Safety Standards (ASPICE/
ISO 26262/ISO 21434) — derived from each course's existing category, not invented
independently of the real catalog. Each page carries `EducationalOrganization`, `ItemList`,
and `BreadcrumbList` structured data, and course pages now link back to their own body's
page (e.g., a CPRE course links to `/certifications/ireb`), building the internal-linking
structure that helps both users and search engines understand the relationship between
courses and the bodies that accredit them.

**Verified with an exact count, not an approximate one**: pulled the course list from each
page's own `ItemList` structured data (not a page-text scrape, which the shared "Talk to
Expert" modal's text would have polluted) and confirmed all 17 courses are mapped to
exactly one body each — 6 IREB, 4 IIBA, 3 INCOSE, 4 Automotive — with zero duplication and
zero courses left unmapped.

**A false alarm caught and correctly dismissed, not left unexplained**: an early broad
keyword check found "CPRE" mentioned on the IIBA page, which would have been a real
cross-contamination bug if true. Traced it to the exact text and found it was the shared
site-wide "Talk to Expert" modal (present on every page, listing "Requirements Engineering
(IREB CPRE)" as one of several dropdown options) — not a course card. Worth stating
plainly rather than silently move past, since it's exactly the kind of false positive that
either gets reported as a real bug or gets ignored without checking; here it was checked
and correctly ruled out.

## Item 7 — Resource detail pages

All six existing "resources" had `url: /contact` — a placeholder, not real external content
— confirming these were never meant to link out and needed genuine on-site articles.
Added a `body` field to the schema, wrote a real, substantive article for each of the six
(matching what their existing excerpts specifically promised, not generic filler), and
built `/resources/:slug` with `Article` and `BreadcrumbList` structured data. The admin form
now supports full article content, with the external-link field made optional — a resource
can be a real on-site article, an external pointer, or (validated) must be at least one of
the two. A resource with no body but a set `url` redirects there automatically, so any
future legitimately-external resource still works without a broken empty detail page.

Verified: the real article content renders (checked for specific phrases from the
articles, not just a 200 status), the listing page's "Get the full guide" links now point
internally, a newly created link-only resource correctly redirects to its external target,
and the sitemap includes only genuine on-site articles — the redirect-only entry is
correctly excluded, since indexing a page whose only content is "redirects elsewhere"
would provide no search value.

## Full regression

Every public route, course registration, and the new resource/certification pages
confirmed working together after every change in this session.

## Confirmation

The course-to-body mapping was verified by an exact count derived from structured data,
not a visual spot-check — the kind of verification that would have caught a real
off-by-one or duplicate mapping had one existed, the same way it caught (and correctly
dismissed) the "CPRE on the IIBA page" false alarm.
