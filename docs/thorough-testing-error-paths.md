# Thorough Testing Report — Error-Handling Paths Under the Configuration Refactor

Scope: given the last change mechanically touched five route files at once (wiring
hardcoded values to config), this pass specifically targeted what that kind of broad,
simultaneous edit is most likely to have disturbed — particularly error-handling paths
that had never been exercised before, since every prior test of file uploads only tried
the *successful* case.

## Two real crash bugs found and fixed — both pre-existing, surfaced by testing failure paths for the first time

**1. An oversized course brochure upload crashed with a raw stack trace instead of a clean
error.** `handleBrochureUpload`'s error path re-rendered `admin/course-form.ejs` without
`faqs`, `examProduct`, or `materials` — three variables the view has required since Phases
3, 4, and 6 respectively, none of which existed when this specific error-handling branch
was originally written. In EJS, referencing a variable that was never passed to `render()`
throws immediately — the template's own `(faqs || [])` fallback only protects against
`null`/`undefined`, not against the identifier being entirely absent. Found while testing
whether the newly config-driven `BROCHURE_MAX_FILE_SIZE_MB` limit actually rejects an
oversized file — it did reject it, but the rejection path itself was broken. Fixed by
supplying all three variables (correctly empty/null when there's no course context, i.e.
the "new course" case) in that one render call. Verified: the same oversized upload now
shows a clean "under 15MB" message with the actual edit form intact, not a crash page.

**2. Trainer and affiliate application uploads had no error handling at all** — unlike
brochures, which have `handleBrochureUpload` specifically to catch Multer errors,
`roeUpload.single("signedRoe")` was wired directly into both application routes with
nothing catching its errors. This meant *both* an oversized file *and* a non-PDF file
crashed with a raw Multer stack trace, not the "must be a PDF" or size-limit message the
code clearly intended to show. Found immediately after fixing bug #1, by checking whether
the equivalent RoE upload path had the same class of problem — it did, and worse, since it
had no wrapper at all rather than an incomplete one. Fixed by adding a `handleRoeUpload`
wrapper mirroring `handleBrochureUpload`'s pattern, applied to both the trainer and
affiliate application routes. Verified: an oversized RoE PDF and a wrong-file-type upload
both now show clean, correct error messages; valid applications for both roles still
succeed afterward.

## Re-verified after the fixes, not assumed unaffected

- **The exact 61/45/15-day discount tier test** (15%/10%/0%) still produces the same
  results after the configuration refactor — confirming the refactor didn't disturb the
  actual math, only moved where the numbers live.
- **The signup rate limiter's distinct max (20, not the 10 used by most other limiters)**
  is genuinely using its own config value, not accidentally cross-wired to a different
  limiter's number — confirmed with 20 successful signups followed by a correctly blocked
  21st.

## Full regression

Every public route, the full registration-to-certificate-to-review chain, admin course
creation, and a fresh affiliate application all confirmed working together after both
fixes, on top of every regression suite from prior sessions.

## Confirmation

Both defects in this pass were pre-existing — neither was introduced by the configuration
refactor itself — but neither had ever been found before, because no prior test attempted
an upload that was actually supposed to fail. Testing only the success path for a feature
that has explicit failure-handling code is exactly how a broken failure path survives
undetected across multiple phases.
