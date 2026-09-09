# Configuration Inventory

Every configurable business parameter in `config/business-rules.json`, per Master Prompt
Section 6. This is a living document — update it whenever a parameter is added, not just at
final delivery.

| Parameter | Description | Unit | Current value | Where used |
|---|---|---|---|---|
| `EARLY_BIRD_1_DAYS` | Days before a session start date at which the first (largest) early-bird discount applies | days | 60 | Checkout discount calculation (Phase 4) |
| `EARLY_BIRD_1_DISCOUNT_PERCENT` | Discount applied at the 60+ day tier | % | 15 | Checkout discount calculation (Phase 4) |
| `EARLY_BIRD_2_DAYS` | Days before a session start date at which the second early-bird discount applies | days | 30 | Checkout discount calculation (Phase 4) |
| `EARLY_BIRD_2_DISCOUNT_PERCENT` | Discount applied at the 30–59 day tier | % | 10 | Checkout discount calculation (Phase 4) |
| `GROUP_TIER_1_MIN_SEATS` | Minimum group size for the first group-discount tier | seats | 3 | Group checkout (Phase 4) |
| `GROUP_TIER_1_DISCOUNT_PERCENT` | Discount at the 3–4 seat tier | % | 10 | Group checkout (Phase 4) |
| `GROUP_TIER_2_MIN_SEATS` | Minimum group size for the second tier | seats | 5 | Group checkout (Phase 4) |
| `GROUP_TIER_2_DISCOUNT_PERCENT` | Discount at the 5–9 seat tier | % | 15 | Group checkout (Phase 4) |
| `GROUP_TIER_3_MIN_SEATS` | Minimum group size for the third tier | seats | 10 | Group checkout (Phase 4) |
| `GROUP_TIER_3_DISCOUNT_PERCENT` | Discount at the 10+ seat tier | % | 20 | Group checkout (Phase 4) |
| `MAX_COMBINED_DISCOUNT_PERCENT` | Cap on early-bird + group discount stacking | % | 25 | Checkout discount calculation (Phase 4) |
| `INSTRUCTOR_PLATFORM_SOURCED_PERCENT` | Instructor's share of a sale the platform itself sourced | % | 60 | Commission calculation (Phase 7) |
| `INSTRUCTOR_REFERRED_PERCENT` | Instructor's share of a sale they referred themselves, for their own course | % | 80 | Commission calculation (Phase 7) |
| `INSTRUCTOR_CORPORATE_BULK_PERCENT` | Instructor's share of a corporate/bulk sale via their own client relationship | % | 70 | Commission calculation (Phase 7) |
| `AFFILIATE_STANDARD_PERCENT` | Standard one-time affiliate commission rate | % | 10 | Commission calculation (Phase 7) |
| `AFFILIATE_HIGH_TIER_PERCENT` | Affiliate rate once the quarterly threshold is exceeded | % | 15 | Commission calculation (Phase 7) |
| `AFFILIATE_HIGH_TIER_QUARTERLY_REVENUE_THRESHOLD_CENTS` | Referred-revenue threshold that unlocks the higher affiliate rate | cents | 500000 (= €/£5,000) | Commission calculation (Phase 7) |
| `REFERRAL_ATTRIBUTION_WINDOW_DAYS` | How long a referral link's cookie remains valid | days | 30 | Referral attribution (Phase 4/7) |
| `MINIMUM_PAYOUT_THRESHOLD_EUR_CENTS` | Minimum accrued balance before a EUR payout is issued | cents | 10000 (= €100) | Payout engine (Phase 7) |
| `MINIMUM_PAYOUT_THRESHOLD_GBP_CENTS` | Minimum accrued balance before a GBP payout is issued | cents | 9000 (= £90) | Payout engine (Phase 7) |
| `PAYOUT_SCHEDULE` | How often payouts are calculated and issued | string | "monthly" | Payout engine (Phase 7) |
| `DEFAULT_MAX_PARTICIPANTS_PER_SESSION` | Default session capacity when a course doesn't set its own | seats or null | null (no default cap) | Session creation (Phase 3) — currently null since no source document specifies a default; do not invent one — set explicitly per course/session instead |
| `PASSWORD_MIN_LENGTH` | Minimum password length for every account type (learner, admin, instructor, affiliate) | characters | 8 | Signup, set-password, trainer/affiliate application (all Phases 2, 7) |
| `LOGIN_LOCKOUT_WINDOW_MINUTES` | How long a login is blocked after too many failed attempts | minutes | 15 | Every login-attempt tracker (admin, learner, trainer, affiliate) |
| `LOGIN_MAX_ATTEMPTS` | Failed attempts allowed before lockout | count | 10 | Every login-attempt tracker |
| `REGISTRATION_RATE_LIMIT_WINDOW_MINUTES` / `_MAX` | Course registration submission rate limit | minutes / count | 10 / 10 | Registration route (Phase 4) |
| `SIGNUP_RATE_LIMIT_WINDOW_MINUTES` / `_MAX` | Learner signup rate limit | minutes / count | 15 / 20 | Signup route (Phase 2) |
| `ONBOARDING_APPLICATION_RATE_LIMIT_WINDOW_MINUTES` / `_MAX` | Trainer/affiliate application rate limit | minutes / count | 15 / 10 | Onboarding routes (Phase 7) |
| `REVIEW_RATE_LIMIT_WINDOW_MINUTES` / `_MAX` | Course review submission rate limit | minutes / count | 60 / 10 | Review route (Phase 3) |
| `BROCHURE_REQUEST_RATE_LIMIT_WINDOW_MINUTES` / `_MAX` | Brochure request rate limit | minutes / count | 10 / 10 | Brochure request route |
| `GENERAL_INQUIRY_FORM_RATE_LIMIT_WINDOW_MINUTES` / `_MAX` | Shared limit for the contact form and corporate-training inquiry form | minutes / count | 10 / 15 | Contact + corporate inquiry routes |
| `BROCHURE_MAX_FILE_SIZE_MB` | Max upload size for course brochure PDFs | MB | 15 | Admin brochure upload |
| `MATERIAL_MAX_FILE_SIZE_MB` | Max upload size for course materials (video/slides allowed) | MB | 100 | Admin materials upload (Phase 6) |
| `ROE_MAX_FILE_SIZE_MB` | Max upload size for signed Rules of Engagement PDFs | MB | 15 | Trainer/affiliate application upload (Phase 7) |

**Explicitly environment-specific, kept out of this file per Section 6 item 6** (in `.env`
instead): `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`,
`PADDLE_ENVIRONMENT`, PayPal equivalents once added, `ADMIN_PASSWORD`, `SESSION_SECRET`,
SMTP credentials.

**Deliberately not in this file**: VAT rates (live in the `vat_rates` table — Section 6
requires admin-editability without a deploy, which a source-controlled JSON file doesn't
provide) and individual course prices/discounts (per-course data in the `courses` table,
not a global business rule).
