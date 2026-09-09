# Comprehensive Testing Report — Primary, Alternate, Exception, Edge, and Error Paths

Scope: every path category requested — primary flows, alternate flows, exception/error
handling, and edge conditions — specifically targeting Phase 6's newest features combined
with everything before them, since that's where an untested seam is most likely to hide.

## One real, exploitable access-control bug found and fixed

**"Mark Complete" had no course-scoping at all.** Unlike every other course-management
action (edit, delete, toggle-publish, FAQs, exam products, materials), the certificate-
issuing action was missing `requireCourseAccess` entirely. Confirmed exploitable: a
`course_admin` with zero assigned courses could mark *any* registration's course complete
and issue a real certificate for it. Fixed using the same lookup-then-scope pattern applied
to every other registration-id-only route (FAQ management, exam product deletion) — look up
the underlying course id first, then check access against that. Verified in all three
directions: unassigned course_admin now correctly blocked (403), the same admin succeeds
once actually assigned (302), and super_admin remains unaffected.

## Certificate issuance stress-tested for the same race condition class found in invoices

Given the invoice numbering race condition was found last session, I didn't assume the
certificate numbering (built using the same pattern, deliberately, from the start) actually
holds under real load — I tested it directly. Eight simultaneous "mark complete" requests
across eight different learners and courses produced exactly eight certificates with eight
unique sequential numbers, zero collisions.

## Verified, not assumed, in this pass

- **CSRF protection covers the newest routes**: a cross-origin attempt on both
  `/admin/registrations/:id/complete` and `/account/feedback/:id` is correctly blocked
  (403).
- **A `pending_payment` (unconfirmed) registration does not grant materials access** — the
  qualifying-registration check correctly excludes this status, tested directly rather than
  inferred from the code.
- **Materials course-scoping works in the positive direction, not just the negative one**:
  a `course_admin` actually assigned to a course can upload a material to it (302) — every
  earlier scoping test in this project had only confirmed the *blocked* case.

## A test-tooling failure caught and corrected before it produced a false result

My first XSS check on material titles returned "safe" — but the upload itself had silently
failed with curl error 26 ("Failed to open/read local data from file"), because `curl -F`
treats a value starting with `<` as an instruction to read the field from a file at that
path, not as literal text. The "safe" result was accidentally correct for the wrong reason:
no material with the script-tag title was ever created, so naturally no script tag
appeared in the output. Caught by checking the actual HTTP status (`000`, not a real
response) rather than trusting the downstream assertion. Redone properly with
`--form-string`, which disables that interpretation: the material was genuinely created
with the literal `<script>alert(1)</script>` title, and confirmed to render correctly
HTML-escaped (`&lt;script&gt;...`) on the public course page — the real, valid
confirmation this was always meant to be.

## Full regression

Every public route, duplicate-registration blocking, admin course creation, "mark
complete" issuing a real certificate visible on the account page, and review submission
succeeding once a genuine completed purchase exists — all confirmed working together in
one continuous pass after every fix in this report.

## Honest residual risk — not eliminated by this pass, and no amount of testing on my end can close it

Everything above was tested against this app's own code and a self-signed/simulated
version of provider behavior. Paddle's webhook signature scheme was implemented from
documentation and has only ever been verified against signatures this same code generated
— never against a real signature from Paddle's servers. PayPal's order creation, capture,
and webhook verification have never been exercised against PayPal's actual API at all, only
checked for graceful failure with no credentials configured. Closing this gap requires
running both integrations against their real sandbox environments with real credentials —
that step has not happened in this project and cannot be substituted for.

## Confirmation

The one real defect found and fixed in this pass (mark-complete scoping) was located by
systematically checking every admin action that operates on a specific course against the
scoping pattern already established for identical actions elsewhere — not by chance. "Zero
defects" is not a claim I can make with certainty for any real system, particularly the
provider-integration gap named above, but this pass genuinely found and closed what could
be found through the testing available to me.
