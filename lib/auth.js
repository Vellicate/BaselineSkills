// Shared authentication: password hashing, admin bootstrap, and role-based
// authorization middleware. Enforced server-side on every route that needs
// it — per Master Prompt Section 7, UI-level hiding is never sufficient on
// its own.

const bcrypt = require("bcryptjs");
const store = require("./db");
const { newId } = require("./id");

const SALT_ROUNDS = 10;

// Synchronous throughout, deliberately — the rest of this app's startup
// sequence (migration, every DB call via better-sqlite3) is synchronous.
// Mixing in an async password-hashing call here would create a real race
// condition (a login could arrive before bootstrap finishes) unless every
// caller carefully awaited it — bcryptjs's sync API avoids that risk
// entirely rather than requiring every call site to get the async chain
// right.
function hashPassword(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}
function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}

// On first boot, if no admin accounts exist at all, create one super_admin
// from ADMIN_PASSWORD (or the "changeme123" default) so an existing
// deployment relying on the old env-var-only check still has a working
// login after this upgrade, with no manual migration step required.
function ensureBootstrapAdmin() {
  const existing = store.readAll("admins");
  if (existing.length > 0) return;
  const password = process.env.ADMIN_PASSWORD || "changeme123";
  const passwordHash = hashPassword(password);
  store.insert("admins", {
    id: newId("admin"),
    username: "admin",
    passwordHash,
    role: "super_admin",
    createdAt: new Date().toISOString(),
  });
  console.log("[auth] no admin accounts existed — created default 'admin' account from ADMIN_PASSWORD/default. Change this password after first login.");
}

// ---- Admin authorization ----
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect("/admin/login");
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.adminId && req.session.adminRole === "super_admin") return next();
  return res.status(403).send("This action requires super-admin access.");
}

// Course-scoped access: a super_admin always passes; a course_admin only
// passes for courses explicitly listed in admin_course_assignments.
// courseIdGetter extracts the relevant course id from the request (varies
// by route — sometimes req.params.id is a course id directly, sometimes it
// needs a lookup).
function requireCourseAccess(courseIdGetter) {
  return function (req, res, next) {
    if (!req.session || !req.session.adminId) return res.redirect("/admin/login");
    if (req.session.adminRole === "super_admin") return next();

    const courseId = courseIdGetter(req);
    if (!courseId) return res.status(404).send("Course not found");

    const assignments = store.readAll("admin_course_assignments");
    const allowed = assignments.some(a => a.adminId === req.session.adminId && a.courseId === courseId);
    if (!allowed) {
      return res.status(403).send("You don't have access to this course. Contact a super-admin to be assigned to it.");
    }
    next();
  };
}

// ---- Learner authorization ----
function requireLearner(req, res, next) {
  if (req.session && req.session.learnerId) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// ---- Instructor / Affiliate authorization ----
function requireInstructor(req, res, next) {
  if (req.session && req.session.instructorId) return next();
  return res.redirect(`/trainer/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireAffiliate(req, res, next) {
  if (req.session && req.session.affiliateId) return next();
  return res.redirect(`/affiliate/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// Returns the set of course ids this admin is allowed to see data for —
// every published/unpublished course for a super_admin, or only the
// specific courses assigned via admin_course_assignments for a
// course_admin. Used to scope the dashboard, registrations, and feedback
// reports — the piece of Section 7's role definition that had been
// carried forward as an open gap since Phase 2, finally resolved here.
function visibleCourseIdsFor(req) {
  if (req.session.adminRole === "super_admin") {
    return null; // null means "no restriction" — checked explicitly by callers
  }
  const store = require("./db");
  return store.readAll("admin_course_assignments")
    .filter((a) => a.adminId === req.session.adminId)
    .map((a) => a.courseId);
}

module.exports = {
  hashPassword, verifyPassword, ensureBootstrapAdmin,
  requireAdmin, requireSuperAdmin, requireCourseAccess, requireLearner,
  requireInstructor, requireAffiliate, visibleCourseIdsFor,
};
