// One-time migration: imports existing JSON data into the new SQLite
// database. Safe to run on every boot — skips any table that already has rows.
const fs = require("fs");
const path = require("path");
const db = require("./db");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");

function loadJson(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`[migrate] failed to parse ${file}:`, e.message);
    return [];
  }
}

function migrateTable(jsonFile, tableName, transform) {
  const existing = db.readAll(tableName);
  if (existing.length > 0) {
    console.log(`[migrate] ${tableName}: already has ${existing.length} row(s), skipping`);
    return;
  }
  const rows = loadJson(jsonFile);
  if (rows.length === 0) {
    console.log(`[migrate] ${tableName}: no data in ${jsonFile}, nothing to do`);
    return;
  }
  let count = 0;
  for (const row of rows) {
    try {
      db.insert(tableName, transform ? transform(row) : row);
      count++;
    } catch (e) {
      console.error(`[migrate] ${tableName}: failed to insert row ${row.id}:`, e.message);
    }
  }
  console.log(`[migrate] ${tableName}: imported ${count}/${rows.length} row(s) from ${jsonFile}`);
}

// Adds any column that's in the CURRENT schema definition (lib/db.js) but
// missing from a table that already existed on disk before that column
// was introduced. `CREATE TABLE IF NOT EXISTS` — used everywhere in
// db.js — only creates a table if it doesn't exist yet; it never alters
// an existing one, so a column added to the schema code after a live
// database was first created is silently never added there. That's a
// real, reproduced bug: a save failed with "table courses has no column
// named practicalApplication" on a course that predated that column,
// even though nothing else was wrong with the submission. Runs before
// anything else in this migration, and checks every table it's given —
// not just the one column that already surfaced — since any other
// column added to any table over time could have the identical problem,
// silently, until someone happens to touch that exact column.
function ensureColumns(table, columnDefs) {
  const existing = new Set(db.raw.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
  columnDefs.forEach(([name, ddlType]) => {
    if (existing.has(name)) return;
    try {
      db.raw.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${ddlType}`);
      console.log(`[migrate] schema: added missing column ${table}.${name}`);
    } catch (e) {
      console.error(`[migrate] schema: failed to add ${table}.${name}:`, e.message);
    }
  });
}

// SQLite cannot ALTER a CHECK constraint on an existing table the way
// ensureColumns above can add a plain column -- adding 'razorpay' as a
// valid paymentProvider value required rebuilding the whole table, not
// just adding one. Reproduced in production: a real registration attempt
// failed with "CHECK constraint failed: paymentProvider IN
// ('paddle','paypal') OR paymentProvider IS NULL" the moment Razorpay was
// actually used, since the CHECK constraint baked into the table at its
// original creation only ever knew about the two providers that existed
// back then.
//
// Idempotent and safe to run on every boot: checks the table's actual
// current CREATE TABLE text first (via sqlite_master) and does nothing
// if it already allows 'razorpay' -- verified with a standalone test
// against a copy of this exact schema, including a child table with a
// foreign key into registrations, before this ever touched the real
// database: data, indexes, and the child table's foreign key
// relationship all survive the rebuild intact, and running this twice in
// a row is a safe no-op the second time.
//
// Other tables (invoices, certificates, etc.) hold foreign keys into this
// one, so this follows SQLite's own documented procedure for exactly this
// situation -- disable foreign key enforcement, rebuild inside a
// transaction, then re-enable it and verify with foreign_key_check --
// rather than DROP TABLE outright, which foreign_keys=ON (set at the top
// of lib/db.js) would otherwise refuse.
function fixRegistrationsPaymentProviderCheck() {
  const row = db.raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='registrations'`).get();
  if (!row || row.sql.includes("'razorpay'")) return;

  console.log("[migrate] schema: rebuilding registrations table to allow paymentProvider='razorpay' (SQLite can't ALTER a CHECK constraint directly)");

  const columns = [
    "id", "courseId", "courseTitle", "learnerId", "name", "email", "phone", "address", "company", "role",
    "sessionStartDate", "deliveryMode", "notes", "priceCentsCharged", "currency",
    "certificationExamId", "examPriceCentsCharged", "vatAmountCents", "vatCountry", "status",
    "referredById", "referralType", "paymentProvider", "paddleTransactionId", "paypalOrderId",
    "groupRegistrationId", "isPurchaser", "participantCount", "baseTotalCents",
    "groupDiscountPercent", "groupDiscountAmountCents", "grantsAccess",
    "razorpayOrderId", "razorpayAmountPaise", "createdAt", "confirmedAt",
  ];
  const columnList = columns.map((c) => `"${c}"`).join(", ");

  db.raw.pragma("foreign_keys = OFF");
  const rebuild = db.raw.transaction(() => {
    db.raw.exec(`
      CREATE TABLE registrations_new (
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
        groupRegistrationId TEXT, isPurchaser INTEGER DEFAULT 1,
        participantCount INTEGER DEFAULT 1, baseTotalCents INTEGER,
        groupDiscountPercent REAL DEFAULT 0, groupDiscountAmountCents INTEGER DEFAULT 0,
        grantsAccess INTEGER DEFAULT 1,
        razorpayOrderId TEXT, razorpayAmountPaise INTEGER,
        createdAt TEXT, confirmedAt TEXT
      );
    `);
    db.raw.exec(`INSERT INTO registrations_new (${columnList}) SELECT ${columnList} FROM registrations`);
    db.raw.exec(`DROP TABLE registrations`);
    db.raw.exec(`ALTER TABLE registrations_new RENAME TO registrations`);
    db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_registrations_course ON registrations(courseId)`);
    db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_registrations_email ON registrations(email)`);
    db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_registrations_group ON registrations(groupRegistrationId)`);
  });
  rebuild();
  db.raw.pragma("foreign_keys = ON");

  const fkCheck = db.raw.pragma("foreign_key_check(registrations)");
  if (fkCheck.length > 0) {
    console.error("[migrate] schema: foreign_key_check found issues after registrations rebuild:", JSON.stringify(fkCheck));
  } else {
    console.log("[migrate] schema: registrations table rebuilt successfully — data and foreign keys verified intact");
  }
}

function run() {
  console.log("[migrate] starting JSON -> SQLite migration, DATA_DIR =", DATA_DIR);

  ensureColumns("courses", [
    ["category", "TEXT"], ["level", "TEXT"], ["summary", "TEXT"], ["description", "TEXT"],
    ["outcomes", "TEXT"], ["curriculum", "TEXT"], ["audience", "TEXT"], ["durationDays", "INTEGER"],
    ["deliveryModes", "TEXT"], ["priceCents", "INTEGER"], ["discountPercent", "REAL DEFAULT 0"],
    ["currency", "TEXT DEFAULT 'EUR'"], ["certification", "INTEGER DEFAULT 0"],
    ["corporateOnly", "INTEGER DEFAULT 0"], ["published", "INTEGER DEFAULT 0"], ["trainerId", "TEXT"],
    ["courseOutlineUrl", "TEXT"], ["whyTakeThisCourse", "TEXT"], ["prerequisites", "TEXT"],
    ["formatAndMaterial", "TEXT"], ["whatYoullReceive", "TEXT"], ["practicalApplication", "TEXT"],
    ["imageUrl", "TEXT"], ["brochureFilename", "TEXT"], ["createdAt", "TEXT"], ["updatedAt", "TEXT"],
  ]);
  ensureColumns("sessions", [
    ["location", "TEXT"], ["language", "TEXT DEFAULT 'English'"],
  ]);
  ensureColumns("instructors", [
    ["workExperience", "TEXT"],
  ]);
  ensureColumns("certification_exams", [
    ["level", "TEXT"], ["durationMinutes", "INTEGER"], ["format", "TEXT"],
    ["passGrade", "TEXT"], ["retakePolicy", "TEXT"], ["availability", "TEXT"],
  ]);
  ensureColumns("courses", [
    ["courseOutlineFilename", "TEXT"],
  ]);
  ensureColumns("courses", [
    ["legacyRatingAverage", "REAL"], ["legacyRatingCount", "INTEGER DEFAULT 0"],
  ]);
  ensureColumns("courses", [
    ["courseOutlineContent", "TEXT"],
  ]);
  ensureColumns("instructors", [
    ["passwordResetToken", "TEXT"], ["passwordResetExpires", "TEXT"],
  ]);
  ensureColumns("affiliates", [
    ["passwordResetToken", "TEXT"], ["passwordResetExpires", "TEXT"],
  ]);
  // Phase 1 repositioning (learn -> practise -> apply narrative): a course
  // can optionally declare the real-world outcome it builds and whether it
  // has a hands-on practice component. practice_enabled defaults false and
  // practice_platform defaults null deliberately -- only courses an admin
  // explicitly turns this on for should ever show practice-related UI, so
  // a course with no opinion on this stays silent rather than guessing.
  ensureColumns("courses", [
    ["learning_outcome", "TEXT"], ["practice_enabled", "INTEGER DEFAULT 0"],
    ["practice_platform", "TEXT"], ["practice_description", "TEXT"], ["learning_path", "TEXT"],
  ]);
  // LMS: the delivery-mode classification the LMS content experience needs
  // (Section 4 of the LMS spec) is deliberately a NEW, separate column, not
  // a reuse of the existing deliveryModes (plural, free-text checkbox
  // array like "Live Online"/"Classroom") -- that field answers a
  // different question (which physical/virtual formats a course is
  // offered in), not the single controlled classification the LMS needs
  // for which kind of learning experience to render. NULL means "no LMS
  // content configured for this course" -- distinct from any of the three
  // real values, so existing courses aren't silently miscategorized.
  ensureColumns("courses", [
    ["lmsDeliveryMode", "TEXT CHECK(lmsDeliveryMode IN ('LIVE_ONLINE','RECORDED','HYBRID') OR lmsDeliveryMode IS NULL)"],
  ]);
  // A course's LMS content can now span more than one delivery mode at
  // once (e.g. a course sold as both Recorded and Live Online, with some
  // lessons common to both and some specific to one) -- the single-value
  // lmsDeliveryMode above couldn't express that. lmsDeliveryModes
  // (plural, JSON array) replaces it going forward; this migration wraps
  // any course that already has the old single value set into a
  // one-element array, so nothing already configured by a trainer is
  // lost or silently reset.
  ensureColumns("courses", [
    ["lmsDeliveryModes", "TEXT"],
  ]);
  {
    const coursesNeedingMigration = db.readAll("courses").filter((c) => c.lmsDeliveryMode && (!c.lmsDeliveryModes || c.lmsDeliveryModes.length === 0));
    coursesNeedingMigration.forEach((c) => db.update("courses", c.id, { lmsDeliveryModes: [c.lmsDeliveryMode] }));
    if (coursesNeedingMigration.length > 0) {
      console.log(`[migrate] courses: wrapped ${coursesNeedingMigration.length} existing lmsDeliveryMode value(s) into the new lmsDeliveryModes array`);
    }
  }
  // Per-lesson targeting: NULL/empty means "common to every one of the
  // course's configured LMS modes" (matching how every lesson created
  // before this feature existed already behaves, so nothing already
  // built needs to be touched), a non-empty array restricts that lesson
  // to only the listed mode(s).
  ensureColumns("lms_lessons", [
    ["applicableModes", "TEXT"],
  ]);
  // Section 28: course-level LMS access window, distinct from the
  // course's existing commercial `sessions` dates (a session's date is
  // when a *live cohort* runs; this is when the *LMS content itself* is
  // reachable at all, which matters just as much for a RECORDED course
  // with no sessions). NULL on either end means unrestricted in that
  // direction -- a course with no dates set is always available, exactly
  // like every course before this feature existed, rather than every
  // existing course suddenly becoming inaccessible on migration.
  ensureColumns("courses", [
    ["lmsAccessStartDate", "TEXT"], ["lmsAccessEndDate", "TEXT"],
  ]);
  // Per-mode access windows: { RECORDED: { startDate, endDate }, LIVE_ONLINE: {...}, HYBRID: {...} }.
  // A mode missing from this object, or either date within it being null,
  // means unrestricted in that direction for that mode -- same "NULL means
  // open" rule as the single-pair fields above, just scoped per mode now.
  ensureColumns("courses", [
    ["lmsAccessWindows", "TEXT"],
  ]);
  {
    const coursesNeedingWindowMigration = db.readAll("courses").filter((c) =>
      (c.lmsAccessStartDate || c.lmsAccessEndDate) && (!c.lmsAccessWindows || Object.keys(c.lmsAccessWindows).length === 0)
    );
    coursesNeedingWindowMigration.forEach((c) => {
      const modes = (c.lmsDeliveryModes && c.lmsDeliveryModes.length > 0) ? c.lmsDeliveryModes : ["LIVE_ONLINE", "RECORDED", "HYBRID"];
      const windows = {};
      modes.forEach((mode) => { windows[mode] = { startDate: c.lmsAccessStartDate || null, endDate: c.lmsAccessEndDate || null }; });
      db.update("courses", c.id, { lmsAccessWindows: windows });
    });
    if (coursesNeedingWindowMigration.length > 0) {
      console.log(`[migrate] courses: applied ${coursesNeedingWindowMigration.length} existing access-window date(s) to the new per-mode lmsAccessWindows`);
    }
  }
  // Part 1E/1F: "preferred dates, if available" -- a distinct concept from
  // teamSize (which already captures "expected number of participants"
  // as free text, reused rather than adding a second, redundant count
  // field), and worth its own column so an admin reviewing a Corporate
  // On-site/Private Cohort inquiry can see it at a glance rather than it
  // being buried inside the free-text message.
  ensureColumns("inquiries", [
    ["preferredDates", "TEXT"],
  ]);
  // Part 14: group registration support -- every existing registration
  // row is unaffected (groupRegistrationId defaults NULL, isPurchaser
  // defaults 1, participantCount defaults 1), so an existing
  // single-person registration is indistinguishable from "a group of
  // one" at the schema level, matching Part 24's backward-compatibility
  // requirement exactly.
  ensureColumns("registrations", [
    ["groupRegistrationId", "TEXT"], ["isPurchaser", "INTEGER DEFAULT 1"],
    ["participantCount", "INTEGER DEFAULT 1"], ["baseTotalCents", "INTEGER"],
    ["groupDiscountPercent", "REAL DEFAULT 0"], ["groupDiscountAmountCents", "INTEGER DEFAULT 0"],
    // Part 15: "the purchaser should not automatically receive learner
    // access unless they are also registered as a participant" -- a
    // purchaser-only row (paid for the group but isn't attending) still
    // needs to exist, to hold the payment/pricing data and anchor the
    // group, but must not itself grant LMS access the way every other
    // registration row implicitly does. Defaults to 1 (grants access,
    // exactly today's behavior) so every existing row is unaffected;
    // only ever set to 0 for a non-attending purchaser's row.
    ["grantsAccess", "INTEGER DEFAULT 1"],
    // Razorpay: this app's India-domestic payment gateway, added
    // alongside paddleTransactionId and paypalOrderId (declared directly
    // in the initial CREATE TABLE in lib/db.js, since they existed before
    // this table did) after discovering PayPal cannot process India-to-
    // India transactions at all. razorpayAmountPaise stores the actual
    // INR amount charged (computed once, at order-creation time, using
    // whatever EUR_TO_INR_RATE was in effect then) so the checkout page
    // and any later reconciliation always agree on what was actually
    // charged, rather than recomputing it later against a rate that may
    // have since changed.
    ["razorpayOrderId", "TEXT"], ["razorpayAmountPaise", "INTEGER"],
  ]);
  // Created here, not in the initial schema in lib/db.js, specifically
  // because groupRegistrationId is only guaranteed to exist on THIS line
  // -- on an existing production database, the CREATE TABLE IF NOT EXISTS
  // for registrations is a no-op (the table already existed before this
  // column did), so an index referencing it there would run before
  // ensureColumns ever added the column and crash the whole boot, which
  // is exactly what happened in production before this fix.
  db.raw.exec(`CREATE INDEX IF NOT EXISTS idx_registrations_group ON registrations(groupRegistrationId)`);
  fixRegistrationsPaymentProviderCheck();

  // Defaults to 1 (downloadable) so every existing uploaded material keeps
  // behaving exactly as it did before this column existed -- the "View
  // only, no download" restriction only ever applies to a material an
  // admin explicitly uploads with the new checkbox unticked.
  ensureColumns("materials", [
    ["downloadable", "INTEGER DEFAULT 1"],
  ]);

  const existingCourses = db.readAll("courses");
  if (existingCourses.length === 0) {
    if (fs.existsSync(path.join(DATA_DIR, "courses.json"))) {
      migrateTable("courses.json", "courses");
    } else {
      const seedPath = path.join(__dirname, "..", "seed", "courses.seed.json");
      const seedCourses = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      let count = 0;
      for (const row of seedCourses) {
        try { db.insert("courses", row); count++; } catch (e) { console.error("[migrate] seed course failed:", row.id, e.message); }
      }
      console.log(`[migrate] courses: fresh install, seeded ${count}/${seedCourses.length} from bundled seed/courses.seed.json`);
    }
  } else {
    console.log(`[migrate] courses: already has ${existingCourses.length} row(s), skipping`);
  }

  migrateTable("trainers.json", "trainers");
  migrateTable("blogs.json", "blogs");

  // resources: fresh install falls back to the bundled seed, same pattern as courses
  const existingResources = db.readAll("resources");
  if (existingResources.length === 0) {
    if (fs.existsSync(path.join(DATA_DIR, "resources.json")) && loadJson("resources.json").length > 0) {
      migrateTable("resources.json", "resources");
    } else {
      const seedPath = path.join(__dirname, "..", "seed", "resources.seed.json");
      if (fs.existsSync(seedPath)) {
        const seedResources = JSON.parse(fs.readFileSync(seedPath, "utf8"));
        let count = 0;
        for (const row of seedResources) {
          try { db.insert("resources", row); count++; } catch (e) { console.error("[migrate] seed resource failed:", row.id, e.message); }
        }
        console.log(`[migrate] resources: fresh install, seeded ${count}/${seedResources.length} from bundled seed`);
      }
    }
  } else {
    console.log(`[migrate] resources: already has ${existingResources.length} row(s), skipping`);
  }

  // site_settings: the homepage proof/statistics section (Section 9 of the
  // redesign brief) — these are real, verified business figures, not
  // invented placeholders, seeded once on fresh install and editable
  // afterward through the admin settings page.
  const existingFoundedYear = db.getSetting("stat_founded_year", null);
  if (existingFoundedYear === null) {
    db.setSetting("stat_founded_year", "2009");
    db.setSetting("stat_average_rating", "4.8");
    db.setSetting("stat_professionals_trained", "20,000+");
    db.setSetting("stat_industries_served", "10+");
    console.log("[migrate] site_settings: fresh install, seeded homepage statistics");
  } else {
    console.log("[migrate] site_settings: already configured, skipping");
  }

  // standards_bodies: fresh install falls back to the bundled seed, same pattern as resources
  const existingBodies = db.readAll("standards_bodies");
  if (existingBodies.length === 0) {
    const bodySeedPath = path.join(__dirname, "..", "seed", "standards-bodies.seed.json");
    if (fs.existsSync(bodySeedPath)) {
      const seedBodies = JSON.parse(fs.readFileSync(bodySeedPath, "utf8"));
      let count = 0;
      for (const row of seedBodies) {
        try { db.insert("standards_bodies", row); count++; } catch (e) { console.error("[migrate] seed standards body failed:", row.id, e.message); }
      }
      console.log(`[migrate] standards_bodies: fresh install, seeded ${count}/${seedBodies.length} from bundled seed`);
    }
  } else {
    console.log(`[migrate] standards_bodies: already has ${existingBodies.length} row(s), skipping`);
  }

  // course_standards_mapping: links each course to its certifying body, derived
  // from category — Requirements Engineering -> IREB, Business Analysis -> IIBA,
  // Systems Engineering -> INCOSE, Automotive -> Automotive & Functional Safety
  // Standards. Only runs once (fresh install), same idempotency guard as every
  // other seed block, so re-running migration never creates duplicate mappings.
  const existingMappings = db.readAll("course_standards_mapping");
  if (existingMappings.length === 0) {
    const categoryToBodySlug = {
      "Requirements Engineering": "ireb",
      "Business Analysis": "iiba",
      "Systems Engineering": "incose",
      "Automotive": "automotive-standards",
    };
    const bodies = db.readAll("standards_bodies");
    const courses = db.readAll("courses");
    let count = 0;
    for (const course of courses) {
      const bodySlug = categoryToBodySlug[course.category];
      const body = bodySlug ? bodies.find((b) => b.slug === bodySlug) : null;
      if (!body) continue;
      try {
        db.insert("course_standards_mapping", {
          id: `mapping_${course.id}`, courseId: course.id, standardsBodyId: body.id,
          syllabusVersion: null, accreditationStatus: "accredited",
        });
        count++;
      } catch (e) { console.error("[migrate] course-standards mapping failed:", course.id, e.message); }
    }
    if (courses.length > 0) console.log(`[migrate] course_standards_mapping: fresh install, mapped ${count}/${courses.length} courses to their certifying body`);
  } else {
    console.log(`[migrate] course_standards_mapping: already has ${existingMappings.length} row(s), skipping`);
  }

  // course_categories: additional categories a course belongs to, beyond
  // its single primary `category` column — e.g. AI4RE is primarily a
  // Requirements Engineering course (preserving its correct IREB
  // certification mapping, which is keyed off the primary category) but
  // also genuinely belongs under AI. Only runs once, same idempotency
  // guard as every other seed block here.
  const existingCourseCategories = db.readAll("course_categories");
  if (existingCourseCategories.length === 0) {
    const ai4re = db.readAll("courses").find((c) => c.slug === "ai4re-microcredential");
    let count = 0;
    if (ai4re) {
      try {
        db.insert("course_categories", { id: `cc_${ai4re.id}_ai`, courseId: ai4re.id, category: "AI" });
        count++;
      } catch (e) { console.error("[migrate] course_categories seed failed:", e.message); }
    }
    console.log(`[migrate] course_categories: fresh install, added ${count} additional category mapping(s)`);
  } else {
    console.log(`[migrate] course_categories: already has ${existingCourseCategories.length} row(s), skipping`);
  }

  // categories: the admin-manageable list of course categories. Seeded
  // once with the 7 categories the site already uses, so existing
  // installs see no change — this just makes the list a real,
  // admin-editable entity instead of a hardcoded array in the code.
  const existingCategories = db.readAll("categories");
  if (existingCategories.length === 0) {
    const defaults = ["Requirements Engineering", "Systems Engineering", "Business Analysis", "Project Management", "Business Process Modeling", "AI", "Automotive"];
    let count = 0;
    defaults.forEach((name, i) => {
      try {
        db.insert("categories", { id: `cat_${i}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name, createdAt: new Date().toISOString() });
        count++;
      } catch (e) { console.error("[migrate] categories seed failed:", e.message); }
    });
    console.log(`[migrate] categories: fresh install, seeded ${count}/${defaults.length} default categories`);
  } else {
    console.log(`[migrate] categories: already has ${existingCategories.length} row(s), skipping`);
  }

  // course_discounts: one-time conversion of the old single flat
  // courses.discountPercent value into the new multi-discount system, so
  // no existing promotional pricing is lost when the mechanism changes.
  // Converted as a "no expiry" entry (blank start = always applicable,
  // blank end = doesn't expire until the session itself starts) —
  // functionally identical to how discountPercent behaved before.
  // Guarded on course_discounts being completely empty, not per-course,
  // since a partial re-run should never re-add an entry an admin has
  // since edited or removed.
  const existingCourseDiscounts = db.readAll("course_discounts");
  if (existingCourseDiscounts.length === 0) {
    const coursesWithFlatDiscount = db.readAll("courses").filter((c) => c.discountPercent > 0);
    let count = 0;
    coursesWithFlatDiscount.forEach((c, i) => {
      try {
        db.insert("course_discounts", {
          id: `cdisc_${i}_${c.id}`, courseId: c.id,
          label: "Standing Discount", percent: c.discountPercent,
          startDate: null, endDate: null,
          createdAt: new Date().toISOString(),
        });
        count++;
      } catch (e) { console.error("[migrate] course_discounts seed failed:", e.message); }
    });
    console.log(`[migrate] course_discounts: fresh install, converted ${count} existing flat discount(s) to the new system`);
  } else {
    console.log(`[migrate] course_discounts: already has ${existingCourseDiscounts.length} row(s), skipping`);
  }

  // Legacy-data correction — not a "seed once" block like the ones above.
  // A schema DEFAULT or a code fix only affects *new* rows; it never
  // retroactively touches rows that were already written with the old
  // value. This runs every time (safe to repeat — fixing an
  // already-correct row does nothing) so existing installs actually get
  // the correction, not just fresh ones.
  try {
    const usdCourses = db.raw.prepare("UPDATE courses SET currency = 'EUR' WHERE currency = 'USD' OR currency IS NULL OR currency = ''").run();
    if (usdCourses.changes > 0) console.log(`[migrate] legacy-data: corrected currency to EUR on ${usdCourses.changes} course(s)`);
  } catch (e) { console.error("[migrate] legacy-data currency fix failed:", e.message); }
  try {
    const indiaSessions = db.raw.prepare("UPDATE sessions SET mode = 'Classroom' WHERE mode = 'Classroom (India)'").run();
    if (indiaSessions.changes > 0) console.log(`[migrate] legacy-data: corrected ${indiaSessions.changes} session(s) from 'Classroom (India)' to 'Classroom'`);
  } catch (e) { console.error("[migrate] legacy-data session-mode fix failed:", e.message); }

  migrateTable("registrations.json", "registrations");
  migrateTable("inquiries.json", "inquiries");
  migrateTable("admins.json", "admins");
  migrateTable("email-log.json", "email-log");

  console.log("[migrate] done.");
}

if (require.main === module) run();
module.exports = { run };
