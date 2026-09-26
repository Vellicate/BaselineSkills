// Full marketplace database layer — replaces the flat-JSON lib/store.js.
// Implements the complete schema from Baseline_Skills_Database_Design.docx
// (Domains A-H, 48 tables) plus `blogs` and `resources`, which are real,
// live content types on the site today but were not in scope when that
// document was written — added here to satisfy "preserve existing
// functionality" rather than silently dropped.
//
// API surface (readAll/findOne/insert/update/remove) intentionally matches
// the old store.js, so existing route code needs only an import swap for
// anything that was already working (courses, trainers[->instructors],
// blogs, resources, registrations, inquiries, admins).

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { newId } = require("./id");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "baseline-skills.sqlite3");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema: Domain A — Identity & Accounts ──────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS learners (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, passwordHash TEXT,
  name TEXT, country TEXT, phone TEXT,
  passwordResetToken TEXT, passwordResetExpires TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS instructors (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, passwordHash TEXT,
  name TEXT NOT NULL, title TEXT, bio TEXT, photoPath TEXT, profileUrl TEXT,
  verificationStatus TEXT DEFAULT 'pending', payoutAccountRef TEXT,
  signedRoePath TEXT, rejectionReason TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS affiliates (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, passwordHash TEXT,
  name TEXT NOT NULL, organization TEXT, commissionTier TEXT DEFAULT 'standard',
  payoutAccountRef TEXT, status TEXT DEFAULT 'pending',
  signedRoePath TEXT, rejectionReason TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corporate_accounts (
  id TEXT PRIMARY KEY, companyName TEXT NOT NULL, contactName TEXT, contactEmail TEXT,
  seatCount INTEGER DEFAULT 0, billingAddress TEXT, vatNumber TEXT, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY, username TEXT UNIQUE, passwordHash TEXT,
  role TEXT DEFAULT 'super_admin', createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_course_assignments (
  id TEXT PRIMARY KEY,
  adminId TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  assignedAt TEXT NOT NULL,
  UNIQUE(adminId, courseId)
);
`);

// ── Domain B — Course Catalog & Content ─────────────────────────────────
// (courses/sessions/materials created before admin_course_assignments above
// via a second exec, since admin_course_assignments FKs to courses — SQLite
// resolves FK references at write-time not create-time, so table creation
// order across these two exec() blocks is fine as long as both run before
// any insert.)
db.exec(`
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  category TEXT, level TEXT, summary TEXT, description TEXT,
  outcomes TEXT, curriculum TEXT, audience TEXT, durationDays INTEGER,
  deliveryModes TEXT, priceCents INTEGER, discountPercent REAL DEFAULT 0, currency TEXT DEFAULT 'EUR',
  certification INTEGER DEFAULT 0, corporateOnly INTEGER DEFAULT 0, published INTEGER DEFAULT 0,
  trainerId TEXT REFERENCES instructors(id) ON DELETE SET NULL,
  courseOutlineUrl TEXT, whyTakeThisCourse TEXT, prerequisites TEXT,
  formatAndMaterial TEXT, whatYoullReceive TEXT, practicalApplication TEXT,
  imageUrl TEXT, brochureFilename TEXT, createdAt TEXT, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  startDate TEXT, endDate TEXT, timeFrom TEXT, timeTo TEXT, mode TEXT,
  location TEXT, language TEXT DEFAULT 'English',
  seatsLeft INTEGER, createdAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(courseId);
-- Part 1/3: price belongs to the purchasable delivery offering, not
-- blindly to the course -- one row per delivery mode a course actually
-- offers, priced independently (Recorded must never derive its price
-- from Live Online/Classroom). Deliberately not one column per mode
-- (price_LIVE_ONLINE, price_RECORDED, ...): that would be exactly the
-- hard-coded-per-mode shape the spec repeatedly warns against, and would
-- need a schema change every time a new mode is added. Corporate
-- On-site/Private Cohort rows may have priceCents NULL -- "no public
-- purchase price required", per Part 4 -- meaning NULL here is a
-- meaningful business state (price handled offline), not missing data.
-- No row for a mode means that mode simply isn't offered for this course.
CREATE TABLE IF NOT EXISTS course_delivery_options (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  deliveryMode TEXT NOT NULL CHECK(deliveryMode IN ('Live Online','Classroom','Recorded','Hybrid','Corporate On-site','Private Cohort')),
  priceCents INTEGER, currency TEXT DEFAULT 'EUR',
  createdAt TEXT NOT NULL, updatedAt TEXT,
  UNIQUE(courseId, deliveryMode)
);
CREATE INDEX IF NOT EXISTS idx_delivery_options_course ON course_delivery_options(courseId);
-- Part 8/9: the slab model, per course -- a course with no rows here
-- falls back to the documented defaults (3-5=15%, 6-9=20%, 10+=25%) at
-- the application layer, rather than every course needing rows inserted
-- just to get the default behaviour. maxParticipants NULL means "and
-- above" (the 10+ slab).
CREATE TABLE IF NOT EXISTS course_group_discount_rules (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  minParticipants INTEGER NOT NULL, maxParticipants INTEGER,
  discountPercent REAL NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_discount_course ON course_group_discount_rules(courseId);
CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT, "order" INTEGER, videoUrl TEXT, durationMinutes INTEGER
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, filePath TEXT NOT NULL, fileType TEXT,
  fileSizeBytes INTEGER, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS course_sequences (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  nextCourseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE
);
-- LMS: a course's actual learning content, separate from the commercial/
-- catalogue course row above. Deliberately its own table hierarchy rather
-- than fields bolted onto courses/sessions -- one commercial course can
-- eventually have multiple delivery instances (a live cohort, a recorded
-- self-paced version) that could reasonably share the same underlying
-- content, which a course-content coupling would foreclose.
-- position is REAL, not INTEGER, so a lesson/module can be inserted between
-- two existing ones (e.g. position 1.5 between 1 and 2) without renumbering
-- every sibling -- the reordering endpoint always re-sequences to clean
-- integers after a drag-drop save, but nothing else depends on that.
CREATE TABLE IF NOT EXISTS lms_modules (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, position REAL NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS lms_lessons (
  id TEXT PRIMARY KEY, moduleId TEXT NOT NULL REFERENCES lms_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT,
  contentType TEXT NOT NULL CHECK(contentType IN ('RICH_TEXT','VIDEO','PDF','DOCUMENT','PRESENTATION','QUIZ','ASSIGNMENT')),
  bodyHtml TEXT, position REAL NOT NULL DEFAULT 0,
  isPublished INTEGER NOT NULL DEFAULT 0,
  previewEnabled INTEGER NOT NULL DEFAULT 0,
  downloadAllowed INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS lms_lesson_completions (
  id TEXT PRIMARY KEY, lessonId TEXT NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  completedAt TEXT NOT NULL,
  UNIQUE(lessonId, learnerId)
);
-- One asset per lesson today (a VIDEO/PDF/DOCUMENT/PRESENTATION lesson has
-- exactly one file). storageKey is the actual filename on disk, deliberately
-- separate from originalFilename (the name to show/download as) -- the two
-- are never the same value, since storageKey is a generated ID + extension
-- specifically to avoid path-traversal/collision issues from trusting a
-- user-supplied filename as a real path component.
CREATE TABLE IF NOT EXISTS lms_content_assets (
  id TEXT PRIMARY KEY, lessonId TEXT NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  storageKey TEXT NOT NULL, originalFilename TEXT, mimeType TEXT, sizeBytes INTEGER,
  durationSeconds INTEGER, thumbnailStorageKey TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lms_video_progress (
  id TEXT PRIMARY KEY, lessonId TEXT NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  lastPositionSeconds REAL NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  UNIQUE(lessonId, learnerId)
);
-- Quiz engine (Sections 19-25, 44-47). One quiz per QUIZ-type lesson --
-- lessonId is UNIQUE, not just indexed, so a lesson can never end up with
-- two quiz configurations pointing at it.
CREATE TABLE IF NOT EXISTS lms_quizzes (
  id TEXT PRIMARY KEY, lessonId TEXT NOT NULL UNIQUE REFERENCES lms_lessons(id) ON DELETE CASCADE,
  timeLimitSeconds INTEGER, maxAttempts INTEGER NOT NULL DEFAULT 1,
  passPercentage REAL NOT NULL DEFAULT 70,
  negativeMarkingEnabled INTEGER NOT NULL DEFAULT 0,
  showCorrectAnswers INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT
);
-- Stored once, referenced by multiple questions (Section 20: "the case
-- study should be stored once. Questions reference the case study. Do
-- not duplicate case-study text unnecessarily").
CREATE TABLE IF NOT EXISTS lms_case_studies (
  id TEXT PRIMARY KEY, quizId TEXT NOT NULL REFERENCES lms_quizzes(id) ON DELETE CASCADE,
  title TEXT, content TEXT NOT NULL, position REAL NOT NULL DEFAULT 0
);
-- TRUE_FALSE is its own questionType value (distinct in the UI and in
-- scoring/reporting) but deliberately reuses lms_question_options for its
-- two options (True/False) rather than a separate boolean column --
-- Section 11's "use a common content-item model where appropriate"
-- applied to question types the same way it was applied to lesson
-- content types.
CREATE TABLE IF NOT EXISTS lms_questions (
  id TEXT PRIMARY KEY, quizId TEXT NOT NULL REFERENCES lms_quizzes(id) ON DELETE CASCADE,
  caseStudyId TEXT REFERENCES lms_case_studies(id) ON DELETE SET NULL,
  questionType TEXT NOT NULL CHECK(questionType IN ('MCQ','MULTI_SELECT','TRUE_FALSE','SHORT_ANSWER')),
  questionText TEXT NOT NULL, explanation TEXT,
  marks REAL NOT NULL DEFAULT 1, negativeMarks REAL NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS lms_question_options (
  id TEXT PRIMARY KEY, questionId TEXT NOT NULL REFERENCES lms_questions(id) ON DELETE CASCADE,
  optionText TEXT NOT NULL, isCorrect INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0
);
-- Never overwritten (Section 23/91): every attempt is its own row,
-- attemptNumber is assigned once at creation and never reused even if an
-- earlier attempt is later deleted. expiresAt is computed and persisted
-- at start time from the quiz's timeLimitSeconds, not recomputed from the
-- client's clock on submit (Section 46).
CREATE TABLE IF NOT EXISTS lms_quiz_attempts (
  id TEXT PRIMARY KEY, quizId TEXT NOT NULL REFERENCES lms_quizzes(id) ON DELETE CASCADE,
  learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  attemptNumber INTEGER NOT NULL,
  startedAt TEXT NOT NULL, expiresAt TEXT, submittedAt TEXT,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK(status IN ('IN_PROGRESS','SUBMITTED','EXPIRED','PENDING_MANUAL_GRADING')),
  score REAL, percentage REAL, passed INTEGER
);
-- answerData is JSON: an option id for MCQ/TRUE_FALSE, an array of option
-- ids for MULTI_SELECT (Section 45: "persist selected options as a
-- structured representation... do not store only display text"), or raw
-- text for SHORT_ANSWER. isCorrect/marksAwarded are NULL until scored --
-- for SHORT_ANSWER specifically, they stay NULL until a teacher grades it
-- (Section 25), not auto-filled.
CREATE TABLE IF NOT EXISTS lms_quiz_answers (
  id TEXT PRIMARY KEY, attemptId TEXT NOT NULL REFERENCES lms_quiz_attempts(id) ON DELETE CASCADE,
  questionId TEXT NOT NULL REFERENCES lms_questions(id) ON DELETE CASCADE,
  answerData TEXT, isCorrect INTEGER, marksAwarded REAL,
  gradedAt TEXT, gradedBy TEXT,
  UNIQUE(attemptId, questionId)
);
-- One assignment per ASSIGNMENT-type lesson, same pattern as lms_quizzes.
-- allowedFileTypes is a comma-separated list of extensions (".pdf,.docx")
-- rather than its own table -- Section 26 lists it as one configuration
-- value on the assignment, not a set of rows with their own lifecycle.
CREATE TABLE IF NOT EXISTS lms_assignments (
  id TEXT PRIMARY KEY, lessonId TEXT NOT NULL UNIQUE REFERENCES lms_lessons(id) ON DELETE CASCADE,
  instructions TEXT, deadline TEXT, maxMarks REAL NOT NULL DEFAULT 100,
  allowedFileTypes TEXT NOT NULL DEFAULT '.pdf,.doc,.docx',
  maxFileSizeMB INTEGER NOT NULL DEFAULT 20,
  allowResubmission INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT
);
-- Section 27/91: never overwritten -- a resubmission is a new row with
-- the next submissionNumber, not an update to the previous one, so a
-- teacher grading submission #1 never has the file or content silently
-- change underneath them, and the full history survives even if the
-- student replaces their work five times before the deadline.
CREATE TABLE IF NOT EXISTS lms_assignment_submissions (
  id TEXT PRIMARY KEY, assignmentId TEXT NOT NULL REFERENCES lms_assignments(id) ON DELETE CASCADE,
  learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  submissionNumber INTEGER NOT NULL,
  submittedAt TEXT NOT NULL, isLate INTEGER NOT NULL DEFAULT 0,
  storageKey TEXT NOT NULL, originalFilename TEXT, mimeType TEXT, sizeBytes INTEGER,
  marks REAL, feedback TEXT, gradedAt TEXT, gradedBy TEXT,
  UNIQUE(assignmentId, learnerId, submissionNumber)
);
CREATE TABLE IF NOT EXISTS standards_bodies (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT NOT NULL, description TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS course_discounts (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  label TEXT, percent REAL NOT NULL,
  startDate TEXT, endDate TEXT,
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS coupon_codes (
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, percent REAL NOT NULL,
  courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  startDate TEXT, endDate TEXT, active INTEGER DEFAULT 1,
  createdAt TEXT
);
CREATE TABLE IF NOT EXISTS course_standards_mapping (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  standardsBodyId TEXT NOT NULL REFERENCES standards_bodies(id) ON DELETE CASCADE,
  syllabusVersion TEXT, accreditationStatus TEXT
);
CREATE TABLE IF NOT EXISTS course_categories (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  category TEXT NOT NULL
);
-- Not in the original 47-table design: Master Prompt Section 11 requires
-- certification exams to be managed as a distinct product from the course
-- itself (name, body, price, eligibility, provider, availability) —
-- exam_bookings (Domain C) records a learner's individual booking, but
-- nothing defined the catalog of exams available to book in the first
-- place until now.
CREATE TABLE IF NOT EXISTS certification_exams (
  id TEXT PRIMARY KEY, courseId TEXT REFERENCES courses(id) ON DELETE SET NULL,
  certificationName TEXT NOT NULL, certificationBody TEXT,
  examName TEXT, priceCents INTEGER NOT NULL, description TEXT,
  eligibility TEXT, examProvider TEXT, availability TEXT,
  level TEXT, durationMinutes INTEGER, format TEXT,
  passGrade TEXT, retakePolicy TEXT,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_certification_exams_course ON certification_exams(courseId);
-- Not in the original 47-table design: Master Prompt Section 19 requires real
-- FAQ management (create/edit/delete/reorder/publish), which a text blob on
-- courses can't cleanly support. scope lets the same table serve course FAQs
-- and page-level FAQs (corporate, become-a-trainer) per Section 24.
CREATE TABLE IF NOT EXISTS faqs (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('course','corporate','become_a_trainer')),
  courseId TEXT REFERENCES courses(id) ON DELETE CASCADE,
  question TEXT NOT NULL, answer TEXT NOT NULL,
  "order" INTEGER DEFAULT 0, published INTEGER DEFAULT 1, createdAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_faqs_course ON faqs(courseId);
CREATE TABLE IF NOT EXISTS learning_paths (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  corporateAccountId TEXT REFERENCES corporate_accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS learning_path_courses (
  id TEXT PRIMARY KEY, pathId TEXT NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, "order" INTEGER
);
`);

// ── Domain C — Learning & Assessment ────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS enrollment_progress (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  moduleId TEXT REFERENCES modules(id) ON DELETE SET NULL,
  percentComplete INTEGER DEFAULT 0, completedAt TEXT
);
CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT
);
CREATE TABLE IF NOT EXISTS quiz_questions (
  id TEXT PRIMARY KEY, quizId TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  questionText TEXT, options TEXT, correctAnswer TEXT
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY, quizId TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  score INTEGER, passed INTEGER, attemptNumber INTEGER, submittedAt TEXT
);
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  certificateNumber TEXT UNIQUE,
  issuedAt TEXT, certificateUrl TEXT, badgeUrl TEXT
);
CREATE TABLE IF NOT EXISTS cpd_records (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  certificationType TEXT, hoursEarned REAL, renewalDueDate TEXT
);
CREATE TABLE IF NOT EXISTS exam_bookings (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT REFERENCES courses(id) ON DELETE SET NULL,
  certificationBody TEXT, examDate TEXT, mode TEXT, status TEXT DEFAULT 'booked'
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  rating INTEGER, comment TEXT, verifiedPurchase INTEGER DEFAULT 0, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sessionId TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  moduleId TEXT REFERENCES modules(id) ON DELETE SET NULL,
  stage TEXT CHECK(stage IN ('purchase','module','course_completion')),
  rating INTEGER, comment TEXT, structuredAnswers TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS wishlist_items (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, addedAt TEXT,
  UNIQUE(learnerId, courseId)
);
`);

// ── Domain D — Commerce & Payments ──────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS cart_items (
  id TEXT PRIMARY KEY, learnerId TEXT REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sessionId TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  quantity INTEGER DEFAULT 1, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY, courseId TEXT REFERENCES courses(id) ON DELETE SET NULL,
  courseTitle TEXT, learnerId TEXT REFERENCES learners(id) ON DELETE SET NULL,
  name TEXT, email TEXT, phone TEXT, address TEXT, company TEXT, role TEXT, sessionStartDate TEXT,
  deliveryMode TEXT, notes TEXT, priceCentsCharged INTEGER, currency TEXT DEFAULT 'EUR',
  certificationExamId TEXT REFERENCES certification_exams(id) ON DELETE SET NULL,
  examPriceCentsCharged INTEGER,
  vatAmountCents INTEGER DEFAULT 0, vatCountry TEXT,
  status TEXT DEFAULT 'pending_payment',
  referredById TEXT, referralType TEXT CHECK(referralType IN ('instructor','affiliate') OR referralType IS NULL),
  paymentProvider TEXT CHECK(paymentProvider IN ('paddle','paypal','razorpay') OR paymentProvider IS NULL),
  paddleTransactionId TEXT, paypalOrderId TEXT,
  -- Part 14: one row per person, same as every existing single-person
  -- registration, so isEnrolled(), the LMS dashboard, teacher analytics,
  -- certificates, and the admin registrations list all keep working on
  -- every existing and new registration without any change to how they
  -- query this table -- deliberately not a separate registration_
  -- participants table, which would require updating every one of those
  -- read paths to also check a second table. groupRegistrationId links
  -- every participant of one purchase together (NULL for a standalone
  -- registration, exactly today's row shape); isPurchaser marks the one
  -- row that actually paid (Part 15: "the purchaser should not
  -- automatically receive learner access unless also registered as a
  -- participant" -- a purchaser who isn't attending gets a row with
  -- isPurchaser=1 but no course access implied by that flag alone,
  -- since LMS access is still decided by isEnrolled() the same way it
  -- always was, by this row simply existing for their email/learnerId).
  -- The group's pricing breakdown is stored once, on the purchaser's
  -- row only -- participant rows don't repeat it.
  groupRegistrationId TEXT, isPurchaser INTEGER DEFAULT 1,
  participantCount INTEGER DEFAULT 1, baseTotalCents INTEGER,
  groupDiscountPercent REAL DEFAULT 0, groupDiscountAmountCents INTEGER DEFAULT 0,
  grantsAccess INTEGER DEFAULT 1,
  createdAt TEXT, confirmedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_registrations_course ON registrations(courseId);
CREATE INDEX IF NOT EXISTS idx_registrations_email ON registrations(email);
-- (idx_registrations_group is created later, in migrate-json-to-sqlite.js,
-- after groupRegistrationId is guaranteed to exist via ensureColumns --
-- creating it here would crash on any database where this CREATE TABLE
-- is a no-op because registrations already existed before this column
-- did, which is exactly what happened on the real production database.)
CREATE TABLE IF NOT EXISTS discount_rules (
  id TEXT PRIMARY KEY, scope TEXT CHECK(scope IN ('course','category','global')),
  type TEXT CHECK(type IN ('earlyBird','group')), thresholdValue INTEGER,
  discountPercent REAL, validFrom TEXT, validTo TEXT
);
CREATE TABLE IF NOT EXISTS vat_rates (
  countryCode TEXT PRIMARY KEY, rate REAL NOT NULL,
  type TEXT DEFAULT 'standard', effectiveFrom TEXT
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, registrationId TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  amountCents INTEGER, reason TEXT, processorRefundId TEXT,
  status TEXT DEFAULT 'pending', processedAt TEXT
);
`);

// ── Domain E — Marketplace: Referrals & Payouts ─────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS referral_codes (
  id TEXT PRIMARY KEY, ownerType TEXT CHECK(ownerType IN ('instructor','affiliate')),
  ownerId TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
  courseScope TEXT REFERENCES courses(id) ON DELETE SET NULL,
  validFrom TEXT, validTo TEXT
);
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY, recipientType TEXT CHECK(recipientType IN ('instructor','affiliate')),
  recipientId TEXT NOT NULL, periodStart TEXT, periodEnd TEXT,
  totalAmountCents INTEGER, status TEXT DEFAULT 'pending', paidAt TEXT
);
CREATE TABLE IF NOT EXISTS payout_line_items (
  id TEXT PRIMARY KEY, payoutId TEXT NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  registrationId TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  grossAmountCents INTEGER, rateApplied REAL, netAmountCents INTEGER
);
CREATE TABLE IF NOT EXISTS roe_acknowledgments (
  id TEXT PRIMARY KEY, recipientType TEXT CHECK(recipientType IN ('instructor','affiliate')),
  recipientId TEXT NOT NULL, sentAt TEXT, acknowledgedAt TEXT
);
`);

// ── Domain F — Corporate ─────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS corporate_seats (
  id TEXT PRIMARY KEY, corporateAccountId TEXT NOT NULL REFERENCES corporate_accounts(id) ON DELETE CASCADE,
  learnerEmail TEXT, assignedAt TEXT, status TEXT DEFAULT 'assigned'
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, corporateAccountId TEXT REFERENCES corporate_accounts(id) ON DELETE SET NULL,
  registrationId TEXT REFERENCES registrations(id) ON DELETE SET NULL,
  invoiceNumber TEXT UNIQUE, invoiceDate TEXT,
  amountCents INTEGER, status TEXT DEFAULT 'unpaid', dueDate TEXT, pdfUrl TEXT
);
`);

// ── Domain G — Community & Content Platform (+ blogs/resources) ────────
db.exec(`
CREATE TABLE IF NOT EXISTS testimonials (
  id TEXT PRIMARY KEY, learnerId TEXT REFERENCES learners(id) ON DELETE SET NULL,
  companyName TEXT, quote TEXT, permissionGranted INTEGER DEFAULT 0,
  featured INTEGER DEFAULT 0, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS client_logos (
  id TEXT PRIMARY KEY, companyName TEXT NOT NULL, logoUrl TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  eventDate TEXT, location TEXT, type TEXT
);
CREATE TABLE IF NOT EXISTS event_rsvps (
  id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, subscribedAt TEXT, confirmed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blog_comments (
  id TEXT PRIMARY KEY, postId TEXT NOT NULL, learnerId TEXT REFERENCES learners(id) ON DELETE SET NULL,
  body TEXT, createdAt TEXT, moderated INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  title TEXT, body TEXT, createdAt TEXT
);

-- Not in the original 47-table design: real, live content types found in
-- Phase 0 that already exist on the site (blog posts, RE Pulse resources).
-- Added here, in this domain, since they are content-platform features.
CREATE TABLE IF NOT EXISTS blogs (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  category TEXT, excerpt TEXT, body TEXT, author TEXT,
  published INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  category TEXT, excerpt TEXT, body TEXT, url TEXT, downloadFilename TEXT, createdAt TEXT, updatedAt TEXT
);
`);

// ── Domain H — Operations & Analytics ───────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS course_review_queue (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending', reviewerId TEXT REFERENCES admins(id) ON DELETE SET NULL, reviewedAt TEXT
);
CREATE TABLE IF NOT EXISTS search_logs (
  id TEXT PRIMARY KEY, query TEXT, resultCount INTEGER, timestamp TEXT
);
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY, sessionId TEXT, learnerId TEXT REFERENCES learners(id) ON DELETE SET NULL,
  eventType TEXT, courseId TEXT REFERENCES courses(id) ON DELETE SET NULL, timestamp TEXT
);
CREATE TABLE IF NOT EXISTS nps_surveys (
  id TEXT PRIMARY KEY, learnerId TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  courseId TEXT REFERENCES courses(id) ON DELETE SET NULL, score INTEGER, comment TEXT, submittedAt TEXT
);
CREATE TABLE IF NOT EXISTS emailLog (
  id TEXT PRIMARY KEY, "to" TEXT, "from" TEXT, subject TEXT, html TEXT, text TEXT,
  delivered INTEGER, reason TEXT, loggedAt TEXT
);
CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY, type TEXT, name TEXT, email TEXT, company TEXT, phone TEXT,
  teamSize TEXT, role TEXT, courseInterest TEXT, deliveryMode TEXT, message TEXT, createdAt TEXT
);
`);

// ─────────────────────────────────────────────────────────────────────────
// Generic CRUD layer, API-compatible with the old store.js.
// ─────────────────────────────────────────────────────────────────────────
const TABLES = {
  learners: { table: "learners", json: [] },
  instructors: { table: "instructors", json: [] },
  affiliates: { table: "affiliates", json: [] },
  referral_codes: { table: "referral_codes", json: [] },
  payouts: { table: "payouts", json: [] },
  payout_line_items: { table: "payout_line_items", json: [] },
  roe_acknowledgments: { table: "roe_acknowledgments", json: [] },
  corporate_accounts: { table: "corporate_accounts", json: [] },
  admins: { table: "admins", json: [] },
  admin_course_assignments: { table: "admin_course_assignments", json: [] },
  courses: {
    table: "courses",
    json: ["outcomes", "curriculum", "audience", "deliveryModes", "prerequisites", "whatYoullReceive"],
    jsonArrays: ["outcomes", "curriculum", "audience", "deliveryModes", "prerequisites", "whatYoullReceive"],
    bool: ["certification", "corporateOnly", "published"],
  },
  sessions: { table: "sessions", json: [] },
  course_delivery_options: { table: "course_delivery_options", json: [] },
  course_group_discount_rules: { table: "course_group_discount_rules", json: [] },
  // countryCode is this table's own primary key (no id column at all) --
  // fine for store.readAll, but store.insert/update assume an id column
  // and would fail against this schema, so admin writes to this table go
  // through store.raw directly instead (see the VAT rates admin route).
  vat_rates: { table: "vat_rates", json: [] },
  lms_modules: { table: "lms_modules", json: [] },
  lms_lessons: {
    table: "lms_lessons", json: [],
    bool: ["isPublished", "previewEnabled", "downloadAllowed"],
  },
  lms_lesson_completions: { table: "lms_lesson_completions", json: [] },
  lms_content_assets: { table: "lms_content_assets", json: [] },
  lms_video_progress: { table: "lms_video_progress", json: [] },
  lms_quizzes: {
    table: "lms_quizzes", json: [],
    bool: ["negativeMarkingEnabled", "showCorrectAnswers"],
  },
  lms_case_studies: { table: "lms_case_studies", json: [] },
  lms_questions: { table: "lms_questions", json: [] },
  lms_question_options: {
    table: "lms_question_options", json: [],
    bool: ["isCorrect"],
  },
  lms_quiz_attempts: {
    table: "lms_quiz_attempts", json: [],
    bool: ["passed"],
  },
  lms_quiz_answers: {
    table: "lms_quiz_answers", json: ["answerData"],
    bool: ["isCorrect"],
  },
  lms_assignments: { table: "lms_assignments", json: [], bool: ["allowResubmission"] },
  lms_assignment_submissions: { table: "lms_assignment_submissions", json: [], bool: ["isLate"] },
  modules: { table: "modules", json: [] },
  materials: { table: "materials", json: [] },
  trainers: { table: "instructors", json: ["workExperience"], jsonArrays: ["workExperience"] }, // legacy alias: old routes call store.readAll("trainers")
  blogs: { table: "blogs", json: [], bool: ["published"] },
  resources: { table: "resources", json: [] },
  registrations: { table: "registrations", json: [] },
  inquiries: { table: "inquiries", json: [] },
  faqs: { table: "faqs", json: [], bool: ["published"] },
  reviews: { table: "reviews", json: [], bool: ["verifiedPurchase"] },
  search_logs: { table: "search_logs", json: [] },
  analytics_events: { table: "analytics_events", json: [] },
  course_sequences: { table: "course_sequences", json: [] },
  certification_exams: { table: "certification_exams", json: [] },
  standards_bodies: { table: "standards_bodies", json: [] },
  categories: { table: "categories", json: [] },
  course_discounts: { table: "course_discounts", json: [] },
  coupon_codes: { table: "coupon_codes", json: [] },
  course_standards_mapping: { table: "course_standards_mapping", json: [] },
  course_categories: { table: "course_categories", json: [] },
  invoices: { table: "invoices", json: [] },
  certificates: { table: "certificates", json: [] },
  enrollment_progress: { table: "enrollment_progress", json: [] },
  feedback: { table: "feedback", json: [] },
  "email-log": { table: "emailLog", json: [], bool: ["delivered"] },
};

function rowToObj(def, row) {
  if (!row) return row;
  const obj = { ...row };
  for (const f of def.json || []) {
    if (obj[f] != null && typeof obj[f] === "string") {
      try { obj[f] = JSON.parse(obj[f]); } catch (e) { /* leave as-is */ }
    }
  }
  // Fields that are genuinely arrays (course.outcomes.forEach, .join(), etc.)
  // must never come back as null — a course created any way other than
  // through the admin form's own defaulting (a raw insert, a future import
  // path, a seed file missing the field) would otherwise crash any view
  // that iterates it without its own defensive check. This is deliberately
  // separate from `json` fields in general: a nullable JSON blob (e.g. a
  // future feedback.structuredAnswers) is allowed to genuinely be null —
  // defaulting *that* to [] would be wrong, since [] is truthy in JS and
  // would silently change "no structured answers were given" into "empty
  // structured answers were given."
  for (const f of def.jsonArrays || []) {
    if (obj[f] == null) obj[f] = [];
  }
  for (const f of def.bool || []) {
    if (obj[f] != null) obj[f] = !!obj[f];
  }
  return obj;
}
function objToRow(def, obj) {
  const row = { ...obj };
  for (const f of def.json || []) {
    if (row[f] !== undefined && typeof row[f] !== "string") row[f] = JSON.stringify(row[f] == null ? [] : row[f]);
  }
  for (const f of def.bool || []) {
    // Symmetric with rowToObj's read-side handling: null means "not yet
    // determined" (e.g. a short-answer question awaiting manual grading)
    // and must round-trip as null, not get silently coerced to 0/false --
    // found because a freshly-submitted, ungraded short-answer question
    // was showing as "Incorrect" instead of "awaiting grading" the moment
    // it was written, since `null ? 1 : 0` evaluates to 0. This fixes it
    // for every bool-typed column, not just the one that surfaced it,
    // since any of them could carry the same "unknown yet" meaning.
    if (row[f] !== undefined) row[f] = row[f] == null ? null : (row[f] ? 1 : 0);
  }
  // Empty-string values on FK columns (our naming convention: anything
  // ending in "Id") must become NULL, not "" — "" is a real, non-matching
  // value that violates the FK constraint the moment a form omits a
  // selection rather than never submitting the field at all. This affects
  // every nullable FK across the schema (trainerId today; learnerId,
  // corporateAccountId, etc. as their forms get built in later phases),
  // so it's handled once here rather than patched per-field as each one
  // is discovered.
  for (const key of Object.keys(row)) {
    if (/Id$/.test(key) && row[key] === "") row[key] = null;
  }
  return row;
}
function attachSessions(course) {
  if (!course) return course;
  const rows = db.prepare(`SELECT * FROM sessions WHERE courseId = ? ORDER BY startDate ASC`).all(course.id);
  // id is kept (courseId/createdAt still aren't useful to the app layer) —
  // an earlier version stripped id too, which meant the admin form could
  // never tell replaceSessions which existing row a session corresponded
  // to. Every single save — even completely unchanged ones — deleted
  // every session for the course and reinserted them under brand-new
  // random ids, silently breaking any other table's reference to the old
  // ones (feedback.sessionId, cart_items.sessionId) and needlessly
  // wiping columns (location) that aren't part of the form's own
  // rebuild of each row.
  course.sessions = rows.map(r => { const { courseId, createdAt, ...rest } = r; return rest; });
  return course;
}
// Same attach-on-read convention as attachSessions, for the two new
// per-course child tables (Part 1/8) -- course.deliveryOptions and
// course.groupDiscountRules become naturally available wherever a course
// is loaded, exactly like course.sessions already is, rather than every
// caller needing to know to separately query these tables.
function attachDeliveryOptions(course) {
  if (!course) return course;
  const rows = db.prepare(`SELECT * FROM course_delivery_options WHERE courseId = ? ORDER BY deliveryMode ASC`).all(course.id);
  course.deliveryOptions = rows.map(r => { const { courseId, createdAt, ...rest } = r; return rest; });
  return course;
}
function attachGroupDiscountRules(course) {
  if (!course) return course;
  const rows = db.prepare(`SELECT * FROM course_group_discount_rules WHERE courseId = ? ORDER BY minParticipants ASC`).all(course.id);
  course.groupDiscountRules = rows.map(r => { const { courseId, createdAt, ...rest } = r; return rest; });
  return course;
}

function readAll(name) {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown table: ${name}`);
  const rows = db.prepare(`SELECT * FROM ${def.table}`).all().map(r => rowToObj(def, r));
  if (def.table === "courses") { rows.forEach(attachSessions); rows.forEach(attachDeliveryOptions); rows.forEach(attachGroupDiscountRules); }
  return rows;
}
function findOne(name, predicate) {
  return readAll(name).find(predicate) || null;
}
function insert(name, obj) {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown table: ${name}`);
  if (!obj.id) obj.id = newId(name.replace(/s$/, ""));
  const fullRow = objToRow(def, obj);
  const { sessions, deliveryOptions, groupDiscountRules, ...row } = fullRow;
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${def.table} (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${cols.map(c => `@${c}`).join(", ")})`).run(row);
  if (def.table === "courses" && Array.isArray(obj.sessions)) replaceSessions(obj.id, obj.sessions);
  if (def.table === "courses" && Array.isArray(obj.deliveryOptions)) replaceDeliveryOptions(obj.id, obj.deliveryOptions);
  if (def.table === "courses" && Array.isArray(obj.groupDiscountRules)) replaceGroupDiscountRules(obj.id, obj.groupDiscountRules);
  return findOne(name, r => r.id === obj.id);
}
function update(name, id, patch) {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown table: ${name}`);
  const { sessions, deliveryOptions, groupDiscountRules, ...rest } = patch;
  if (Object.keys(rest).length) {
    const row = objToRow(def, rest);
    const setClause = Object.keys(row).map(c => `"${c}" = @${c}`).join(", ");
    db.prepare(`UPDATE ${def.table} SET ${setClause} WHERE id = @__id`).run({ ...row, __id: id });
  }
  if (def.table === "courses" && Array.isArray(sessions)) replaceSessions(id, sessions);
  if (def.table === "courses" && Array.isArray(deliveryOptions)) replaceDeliveryOptions(id, deliveryOptions);
  if (def.table === "courses" && Array.isArray(groupDiscountRules)) replaceGroupDiscountRules(id, groupDiscountRules);
  return findOne(name, r => r.id === id);
}
function remove(name, id) {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown table: ${name}`);
  db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(id);
}
// Upserts rather than delete-all-then-reinsert: a session row with an id
// (one that already existed) is updated in place, preserving that row's
// database identity and any columns the form doesn't edit (location,
// language) that a blanket reinsert would otherwise silently wipe to
// NULL. A session with no id is a genuinely new row from "+ Add
// session", inserted fresh. Any existing row not present in the
// submitted set at all was removed via the form's "Remove" button, and
// is deleted — never anything the admin didn't actually touch. This
// avoids churning through fresh random ids on every single save
// (even a completely unmodified one), which could otherwise interact
// unpredictably with anything elsewhere that references a session by id.
function replaceSessions(courseId, sessionsArr) {
  const existingIds = new Set(db.prepare(`SELECT id FROM sessions WHERE courseId = ?`).all(courseId).map((r) => r.id));
  const submittedIds = new Set(sessionsArr.filter((s) => s.id).map((s) => s.id));
  const toDelete = [...existingIds].filter((id) => !submittedIds.has(id));

  const del = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  const ins = db.prepare(`INSERT INTO sessions (id, courseId, startDate, endDate, timeFrom, timeTo, mode, location, seatsLeft, createdAt)
    VALUES (@id, @courseId, @startDate, @endDate, @timeFrom, @timeTo, @mode, @location, @seatsLeft, @createdAt)`);
  const upd = db.prepare(`UPDATE sessions SET startDate=@startDate, endDate=@endDate, timeFrom=@timeFrom, timeTo=@timeTo, mode=@mode, location=@location, seatsLeft=@seatsLeft WHERE id=@id AND courseId=@courseId`);

  const tx = db.transaction((rows) => {
    toDelete.forEach((id) => del.run(id));
    for (const s of rows) {
      const values = {
        courseId,
        startDate: s.startDate || "", endDate: s.endDate || "", timeFrom: s.timeFrom || "",
        timeTo: s.timeTo || "", mode: s.mode || "",
        // Optional (Online/Hybrid meeting link, or a physical address for
        // an in-person session) -- previously silently dropped, since
        // neither statement above referenced this column at all despite
        // it existing on the table, meaning a session's location/meeting
        // link could only ever be set by writing to the database
        // directly, never through this form.
        location: s.location || "",
        seatsLeft: s.seatsLeft == null || s.seatsLeft === "" ? null : Number(s.seatsLeft),
      };
      if (s.id && existingIds.has(s.id)) {
        upd.run({ ...values, id: s.id });
      } else {
        ins.run({ ...values, id: s.id || newId("session"), createdAt: new Date().toISOString() });
      }
    }
  });
  tx(sessionsArr);
}
// One row per delivery mode actually offered (Part 1/3) -- upserted by
// deliveryMode itself (the table's own UNIQUE(courseId, deliveryMode)
// constraint), not by a form-supplied id the way sessions are, since a
// course can only ever have one price row per mode; there's no scenario
// needing two "Recorded" rows to disambiguate between. A mode missing
// from the submitted set (the admin unchecked it) has its row removed —
// that mode is no longer offered, and Part 1's "only display rows for
// delivery modes actually configured" depends on absence meaning exactly
// that, not a stale price sitting around for a mode nobody can see.
function replaceDeliveryOptions(courseId, optionsArr) {
  const existing = db.prepare(`SELECT deliveryMode FROM course_delivery_options WHERE courseId = ?`).all(courseId).map((r) => r.deliveryMode);
  const submittedModes = new Set(optionsArr.map((o) => o.deliveryMode));
  const toDelete = existing.filter((m) => !submittedModes.has(m));

  const del = db.prepare(`DELETE FROM course_delivery_options WHERE courseId = ? AND deliveryMode = ?`);
  const upsert = db.prepare(`
    INSERT INTO course_delivery_options (id, courseId, deliveryMode, priceCents, currency, createdAt, updatedAt)
    VALUES (@id, @courseId, @deliveryMode, @priceCents, @currency, @createdAt, @updatedAt)
    ON CONFLICT(courseId, deliveryMode) DO UPDATE SET priceCents=@priceCents, currency=@currency, updatedAt=@updatedAt
  `);

  const tx = db.transaction((rows) => {
    toDelete.forEach((mode) => del.run(courseId, mode));
    const now = new Date().toISOString();
    for (const o of rows) {
      upsert.run({
        id: newId("deliveryoption"), courseId, deliveryMode: o.deliveryMode,
        // NULL is a real, meaningful state here (Part 1E/1F: Corporate
        // On-site / Private Cohort have no public purchase price at all,
        // not a price of zero), not "not yet entered."
        priceCents: (o.priceCents === "" || o.priceCents == null) ? null : Number(o.priceCents),
        currency: o.currency || "EUR",
        createdAt: now, updatedAt: now,
      });
    }
  });
  tx(optionsArr);
}
// Id-based upsert, same reasoning as replaceSessions -- an admin editing
// one slab's percentage shouldn't churn every other slab's row identity.
function replaceGroupDiscountRules(courseId, rulesArr) {
  const existingIds = new Set(db.prepare(`SELECT id FROM course_group_discount_rules WHERE courseId = ?`).all(courseId).map((r) => r.id));
  const submittedIds = new Set(rulesArr.filter((r) => r.id).map((r) => r.id));
  const toDelete = [...existingIds].filter((id) => !submittedIds.has(id));

  const del = db.prepare(`DELETE FROM course_group_discount_rules WHERE id = ?`);
  const ins = db.prepare(`INSERT INTO course_group_discount_rules (id, courseId, minParticipants, maxParticipants, discountPercent, createdAt) VALUES (@id, @courseId, @minParticipants, @maxParticipants, @discountPercent, @createdAt)`);
  const upd = db.prepare(`UPDATE course_group_discount_rules SET minParticipants=@minParticipants, maxParticipants=@maxParticipants, discountPercent=@discountPercent WHERE id=@id AND courseId=@courseId`);

  const tx = db.transaction((rows) => {
    toDelete.forEach((id) => del.run(id));
    for (const r of rows) {
      const values = {
        courseId,
        minParticipants: Number(r.minParticipants),
        maxParticipants: (r.maxParticipants === "" || r.maxParticipants == null) ? null : Number(r.maxParticipants),
        discountPercent: Number(r.discountPercent),
      };
      if (r.id && existingIds.has(r.id)) upd.run({ ...values, id: r.id });
      else ins.run({ ...values, id: r.id || newId("groupdiscount"), createdAt: new Date().toISOString() });
    }
  });
  tx(rulesArr);
}
function upcomingSessions({ from } = {}) {
  const fromDate = from || new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT s.*, c.title AS courseTitle, c.slug AS courseSlug, c.category AS courseCategory
    FROM sessions s JOIN courses c ON c.id = s.courseId
    WHERE c.published = 1 AND (s.startDate >= ? OR s.startDate = 'On Demand')
    ORDER BY s.startDate ASC
  `).all(fromDate);
}

// site_settings is a genuine key-value table (primary key "key", not "id"),
// unlike every other table here — the generic insert/update/remove functions
// above all assume an "id" column, so this gets its own small, direct pair
// of functions rather than being forced through that layer.
function getSetting(key, fallback) {
  const row = db.prepare(`SELECT value FROM site_settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    `INSERT INTO site_settings (key, value, updatedAt) VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = @value, updatedAt = @updatedAt`
  ).run({ key, value: String(value), updatedAt: new Date().toISOString() });
}

module.exports = { readAll, findOne, insert, update, remove, upcomingSessions, getSetting, setSetting, raw: db, DATA_DIR };
