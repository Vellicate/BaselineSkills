# Thorough Testing Report — Phase 0 Through 8, Full System

Scope: primary, alternate, exception, edge, and failure paths across the complete system,
with particular focus on what Phase 8's scoping work newly touches and hadn't been
stress-tested in combination yet.

## Verified correct — including the edge cases most likely to reveal a scoping bug

- **A `course_admin` with zero assignments at all** (not just unassigned to one specific
  course, but never assigned to anything) correctly sees every count as zero and every list
  as empty — no crash, and critically no accidental "empty filter = show everything" leak.
- **The complete mega-flow, now carrying the new phone/address fields**: signup →
  registration (with phone and address) → genuine signed-webhook confirmation → invoice
  generated → admin marks complete → certificate issued → learner submits completion
  feedback → admin's scoped export and feedback report both correctly reflect every step,
  phone and address included. Confirms the schema addition didn't disturb anything
  downstream in a chain that touches five different modules.
- **Combined filters** (course + status together on the registrations report) correctly
  narrow to the intersection, not just each filter checked in isolation.
- **A `course_admin`'s own certificate issuance correctly increments *their own* dashboard
  count** (confirmed 0 → 1 after they personally marked a registration complete) — this
  matters because it would be easy to build scoping that only shows a super_admin's view of
  aggregate counts correctly while leaving a scoped admin's own dashboard silently stale.

## An honest scope boundary, surfaced rather than left ambiguous

Checked whether the trainers-list page is now scoped the same way registrations/feedback/
the dashboard are — **it is not**: a `course_admin` can still view the full trainers list
regardless of role. This is not a new regression from this testing pass; it's the same
carried-forward gap documented since Phase 2. Phase 8's actual mandate (Sections 22, 23,
30) was registration reports, feedback reports, and the dashboard specifically — trainer-
management access control was never in that scope, so its being still-open here is
expected, not silently broken. Worth stating plainly rather than letting "scoping was
addressed in Phase 8" read as broader than it actually was. For contrast, `blogs`
correctly enforces super-admin-only (403) — that boundary is unrelated to course scoping
and has been correct since it was built.

## Full regression

Every public route, the complete registration-to-certificate chain, duplicate-registration
blocking, admin course creation, and a fresh affiliate application all confirmed working
together after this pass.

## Confirmation

The scoping-related checks in this pass specifically targeted scenarios a narrower test
couldn't distinguish from correct behavior (zero assignments, combined filters, a scoped
admin's own action reflecting in their own view) — the same principle that surfaced the
Phase 8 scoping requirement's correctness in the first place, applied again here to close
out the remaining gaps in that same area rather than re-confirm the cases already known to
pass.
