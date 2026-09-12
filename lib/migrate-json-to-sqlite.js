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

function run() {
  console.log("[migrate] starting JSON -> SQLite migration, DATA_DIR =", DATA_DIR);

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

  migrateTable("registrations.json", "registrations");
  migrateTable("inquiries.json", "inquiries");
  migrateTable("admins.json", "admins");
  migrateTable("email-log.json", "email-log");

  console.log("[migrate] done.");
}

if (require.main === module) run();
module.exports = { run };
