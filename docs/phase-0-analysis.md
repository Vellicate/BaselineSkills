# Phase 0 — Analysis Report

## Codebase state (verified directly against the live GitHub repo, not assumed)

The actual repo is **behind** what the Master Prompt's opening assumes. It has grown new
content features since the Database Design document was written, but has **not** received
the SQLite migration from earlier work in this project — it still runs on the flat-JSON
`lib/store.js`. Concretely, as of this clone:

**What exists and works:**
- Public site: Home, Courses (category filter), Course detail, Corporate Training, About,
  Resources, Blog (list/detail), Contact — all real, rendering from `data/*.json`.
- Admin panel: courses, trainers, blogs, resources CRUD (create/edit/delete/publish), plus
  registrations and inquiries views, CSV export.
- Registration + Paddle checkout, with an "invoice pending" fallback when Paddle isn't
  configured. Emails via nodemailer, logged to file if SMTP isn't configured.
- Course brochure upload/download (`lib/brochures.js`).

**What does not exist at all (confirmed by direct route/file inspection):**
- Any database — everything is flat JSON files.
- Any role beyond a single admin password — no Student, Trainer, Affiliate, or Course
  Administrator accounts of any kind.
- PayPal (only Paddle is wired in).
- Everything from Sections 9–29 of the Master Prompt: certification exams as a product,
  shopping cart, invoices, multi-stage feedback, certificates, badges, course
  materials-with-access-control, trainer/affiliate onboarding, commissions, payouts, the
  admin financial dashboard.

## Two real defects found, not related to the marketplace build itself

1. **Two competing rate-limiter implementations exist side by side** — `lib/security.js`
   and `lib/rate-limiter.js`. Only `rate-limiter.js` (the simpler, less careful one) is
   actually wired into the routes. This is a direct violation of Development Rules item 2
   ("do not create duplicate implementations").
2. **`lib/security.js` is dead code** — including a real CSRF defense
   (`requireSameOrigin`) that is never called anywhere. Admin POST routes (course/trainer/
   blog/resource create-edit-delete) currently have **no CSRF protection at all**, despite
   the code to provide it already existing unused in the repo. This is a live security gap
   against Master Prompt Section 32.
   **Recommendation:** delete `rate-limiter.js`, wire `security.js`'s
   `createLoginAttemptTracker` into admin login and `requireSameOrigin` into every
   state-changing admin route, in Phase 2 (Authentication & Roles) or Phase 9's security
   pass at the latest — flagging now so it isn't lost.

## A real gap in the Database Design document itself

`blogs` and `resources` (both live, admin-managed content types with real data) are not
modeled anywhere in the 47-table design — that document was scoped before this content
existed on the live site. Per "preserve existing functionality," both get added as new
tables in Domain G (Community & Content Platform) in the schema built below, rather than
silently dropped.

## Dependency ordering confirmed

Learner accounts → everything downstream of "who is enrolled" (progress, certificates,
reviews, feedback). Instructor/affiliate accounts → commissions/payouts. Payments (both
providers) → invoices → refunds. This matches the phase ordering already set — no changes
needed there.

## Implementation plan for this session

Given the scale gap found, this session implements **Phase 1 only**: the full database
schema (SQLite, via `better-sqlite3`, per the earlier project decision), migrations, seed
data, and the business-rules configuration file — replacing `lib/store.js`. Authentication,
roles, and everything downstream are separate phases, not attempted here, per the
controlled-phase discipline.
