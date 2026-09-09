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
  deliveryModes TEXT, priceCents INTEGER, discountPercent REAL DEFAULT 0, currency TEXT DEFAULT 'USD',
  certification INTEGER DEFAULT 0, corporateOnly INTEGER DEFAULT 0, published INTEGER DEFAULT 0,
  trainerId TEXT REFERENCES instructors(id) ON DELETE SET NULL,
  courseOutlineUrl TEXT, whyTakeThisCourse TEXT, prerequisites TEXT,
  formatAndMaterial TEXT, whatYoullReceive TEXT,
  imageUrl TEXT, brochureFilename TEXT, createdAt TEXT, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  startDate TEXT, endDate TEXT, timeFrom TEXT, timeTo TEXT, mode TEXT,
  seatsLeft INTEGER, createdAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(courseId);
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
CREATE TABLE IF NOT EXISTS standards_bodies (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT NOT NULL, description TEXT
);
CREATE TABLE IF NOT EXISTS course_standards_mapping (
  id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  standardsBodyId TEXT NOT NULL REFERENCES standards_bodies(id) ON DELETE CASCADE,
  syllabusVersion TEXT, accreditationStatus TEXT
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
  createdAt TEXT
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
  deliveryMode TEXT, notes TEXT, priceCentsCharged INTEGER, currency TEXT DEFAULT 'USD',
  certificationExamId TEXT REFERENCES certification_exams(id) ON DELETE SET NULL,
  examPriceCentsCharged INTEGER,
  vatAmountCents INTEGER DEFAULT 0, vatCountry TEXT,
  status TEXT DEFAULT 'pending_payment',
  referredById TEXT, referralType TEXT CHECK(referralType IN ('instructor','affiliate') OR referralType IS NULL),
  paymentProvider TEXT CHECK(paymentProvider IN ('paddle','paypal') OR paymentProvider IS NULL),
  paddleTransactionId TEXT, paypalOrderId TEXT,
  createdAt TEXT, confirmedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_registrations_course ON registrations(courseId);
CREATE INDEX IF NOT EXISTS idx_registrations_email ON registrations(email);
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
  category TEXT, excerpt TEXT, body TEXT, url TEXT, createdAt TEXT, updatedAt TEXT
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
  modules: { table: "modules", json: [] },
  materials: { table: "materials", json: [] },
  trainers: { table: "instructors", json: [] }, // legacy alias: old routes call store.readAll("trainers")
  blogs: { table: "blogs", json: [], bool: ["published"] },
  resources: { table: "resources", json: [] },
  registrations: { table: "registrations", json: [] },
  inquiries: { table: "inquiries", json: [] },
  faqs: { table: "faqs", json: [], bool: ["published"] },
  reviews: { table: "reviews", json: [], bool: ["verifiedPurchase"] },
  search_logs: { table: "search_logs", json: [] },
  course_sequences: { table: "course_sequences", json: [] },
  certification_exams: { table: "certification_exams", json: [] },
  standards_bodies: { table: "standards_bodies", json: [] },
  course_standards_mapping: { table: "course_standards_mapping", json: [] },
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
    if (row[f] !== undefined) row[f] = row[f] ? 1 : 0;
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
  course.sessions = rows.map(r => { const { id, courseId, createdAt, ...rest } = r; return rest; });
  return course;
}

function readAll(name) {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown table: ${name}`);
  const rows = db.prepare(`SELECT * FROM ${def.table}`).all().map(r => rowToObj(def, r));
  if (def.table === "courses") rows.forEach(attachSessions);
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
  const { sessions, ...row } = fullRow;
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${def.table} (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${cols.map(c => `@${c}`).join(", ")})`).run(row);
  if (def.table === "courses" && Array.isArray(obj.sessions)) replaceSessions(obj.id, obj.sessions);
  return findOne(name, r => r.id === obj.id);
}
function update(name, id, patch) {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown table: ${name}`);
  const { sessions, ...rest } = patch;
  if (Object.keys(rest).length) {
    const row = objToRow(def, rest);
    const setClause = Object.keys(row).map(c => `"${c}" = @${c}`).join(", ");
    db.prepare(`UPDATE ${def.table} SET ${setClause} WHERE id = @__id`).run({ ...row, __id: id });
  }
  if (def.table === "courses" && Array.isArray(sessions)) replaceSessions(id, sessions);
  return findOne(name, r => r.id === id);
}
function remove(name, id) {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown table: ${name}`);
  db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(id);
}
function replaceSessions(courseId, sessionsArr) {
  const del = db.prepare(`DELETE FROM sessions WHERE courseId = ?`);
  const ins = db.prepare(`INSERT INTO sessions (id, courseId, startDate, endDate, timeFrom, timeTo, mode, seatsLeft, createdAt)
    VALUES (@id, @courseId, @startDate, @endDate, @timeFrom, @timeTo, @mode, @seatsLeft, @createdAt)`);
  const tx = db.transaction((rows) => {
    del.run(courseId);
    for (const s of rows) {
      ins.run({
        id: s.id || newId("session"), courseId,
        startDate: s.startDate || "", endDate: s.endDate || "", timeFrom: s.timeFrom || "",
        timeTo: s.timeTo || "", mode: s.mode || "",
        seatsLeft: s.seatsLeft == null || s.seatsLeft === "" ? null : Number(s.seatsLeft),
        createdAt: new Date().toISOString(),
      });
    }
  });
  tx(sessionsArr);
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

module.exports = { readAll, findOne, insert, update, remove, upcomingSessions, raw: db };
