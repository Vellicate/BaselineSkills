const express = require("express");
const router = express.Router();
const path = require("path");
const store = require("../lib/db");
const auth = require("../lib/auth");
const { finalizeRegistration, cancelRegistrationGroup, orderIdFieldFor } = require("./registration");
const payments = require("../lib/payments");
const lmsAccess = require("../lib/lms-content-access");
const { LMS_CONTENT_DIR } = require("../lib/lms-content-storage");
const fs = require("fs");
const security = require("../lib/security");
const certificates = require("../lib/certificates");
const payoutsLib = require("../lib/payouts");
const discounts = require("../lib/discounts");
const adminCfg = discounts.loadConfig().security;
const { newId } = require("../lib/id");
const slugify = require("slugify");
const createRateLimiter = require("../lib/rate-limiter");
const multer = require("multer");
const { sendMail, escapeHtml } = require("../lib/mailer");
const { parse: parseCsv } = require("csv-parse/sync");
const crypto = require("crypto");
const { BROCHURE_DIR } = require("../lib/brochures");
const { TRAINER_PHOTO_DIR } = require("../lib/trainer-photos");
const { COURSE_OUTLINE_DIR } = require("../lib/course-outlines");
const { RESOURCE_DOWNLOAD_DIR } = require("../lib/resource-downloads");
const { MATERIAL_DIR } = require("../lib/materials");

const materialUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MATERIAL_DIR),
    filename: (req, file, cb) => cb(null, `${newId("material")}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: adminCfg.MATERIAL_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

// Handles the course form's two independent PDF uploads (brochure and
// course outline) in a single multer pass — multer can only consume a
// multipart request body once, so two file fields on the same form need
// one combined .fields() call rather than two separate .single() calls
// chained as middleware. Both route to their own directory (via
// file.fieldname) and validate as PDF the same way brochures always have.
const courseFileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === "courseOutline" ? COURSE_OUTLINE_DIR : BROCHURE_DIR),
    filename: (req, file, cb) => cb(null, `${newId(file.fieldname === "courseOutline" ? "outline" : "brochure")}.pdf`),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error(file.fieldname === "courseOutline" ? "Course outline must be a PDF file" : "Brochure must be a PDF file"));
    }
    cb(null, true);
  },
  limits: { fileSize: adminCfg.BROCHURE_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

const TRAINER_PHOTO_ALLOWED_MIMES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
const trainerPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TRAINER_PHOTO_DIR),
    filename: (req, file, cb) => cb(null, `${newId("trainerphoto")}${TRAINER_PHOTO_ALLOWED_MIMES[file.mimetype] || ""}`),
  }),
  fileFilter: (req, file, cb) => {
    if (!TRAINER_PHOTO_ALLOWED_MIMES[file.mimetype]) {
      return cb(new Error("Trainer photo must be a JPEG, PNG, or WebP image"));
    }
    cb(null, true);
  },
  limits: { fileSize: adminCfg.TRAINER_PHOTO_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

const RESOURCE_DOWNLOAD_ALLOWED_MIMES = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};
const resourceDownloadUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RESOURCE_DOWNLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${newId("resdl")}${RESOURCE_DOWNLOAD_ALLOWED_MIMES[file.mimetype] || ""}`),
  }),
  fileFilter: (req, file, cb) => {
    if (!RESOURCE_DOWNLOAD_ALLOWED_MIMES[file.mimetype]) {
      return cb(new Error("Resource download must be a PDF, Word, or Excel file"));
    }
    cb(null, true);
  },
  limits: { fileSize: adminCfg.BROCHURE_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

// Bulk-enroll candidate CSV -- memory storage, not disk, since the file is
// parsed once right here and never needs to exist afterwards. 5MB is far
// more than any realistic candidate list needs (tens of thousands of rows
// of name/email/phone).
const csvUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const looksLikeCsv = file.mimetype === "text/csv" || file.mimetype === "application/vnd.ms-excel" || /\.csv$/i.test(file.originalname || "");
    if (!looksLikeCsv) return cb(new Error("Please upload a .csv file"));
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Failure-only login tracking (from lib/security.js): counts only failed
// attempts and clears on success, so a legitimate admin who mistypes their
// password several times isn't then locked out even when they enter the
// correct one — unlike a generic per-request rate limiter, which was found
// during testing to do exactly that after 10 wrong attempts.
const loginAttempts = security.createLoginAttemptTracker({
  windowMs: adminCfg.LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000,
  maxAttempts: adminCfg.LOGIN_MAX_ATTEMPTS,
});

function requireAdmin(req, res, next) {
  return auth.requireAdmin(req, res, next);
}

function verifyOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.headers["origin"] || req.headers["referer"];
  if (!origin) return res.status(403).send("Missing origin header");
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers.host;
    if (originHost !== reqHost) {
      return res.status(403).send("Cross-site request forgery blocked");
    }
  } catch (e) {
    return res.status(403).send("Invalid origin header");
  }
  next();
}

// Helper to pull flash message params from query strings
function getAlerts(req) {
  return {
    success: req.query.success || null,
    error: req.query.error || null,
  };
}

// ---- Auth ----
router.get("/login", (req, res) => {
  if (req.session.adminId) return res.redirect("/admin");
  res.render("admin/login", { title: "Admin login — Baseline Skills" });
});

router.post("/login", (req, res) => {
  const attemptStatus = loginAttempts.check(req);
  if (attemptStatus.blocked) {
    res.set("Retry-After", attemptStatus.retryAfterSeconds);
    return res.status(429).render("admin/login", {
      title: "Admin login — Baseline Skills",
      error: "Too many failed login attempts. Please wait 15 minutes and try again.",
    });
  }

  const { password } = req.body;
  const admins = store.readAll("admins");

  const matched = admins.find(admin => auth.verifyPassword(password, admin.passwordHash));

  if (matched) {
    loginAttempts.recordSuccess(req);
    return req.session.regenerate((err) => {
      if (err) {
        return res.status(500).render("admin/login", {
          title: "Admin login — Baseline Skills",
          error: "Session creation error.",
        });
      }
      req.session.adminId = matched.id;
      req.session.adminRole = matched.role;
      return res.redirect("/admin?success=Welcome+back!");
    });
  }
  loginAttempts.recordFailure(req);
  res.render("admin/login", { title: "Admin login — Baseline Skills", error: "Incorrect password." });
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

router.use(requireAdmin); // everything below this line requires admin auth
router.use(verifyOrigin); // enforce CSRF origin protection for admin POST requests

// Makes the pending-trainer-application count available to every admin
// page render, including the shared sidebar partial (views/admin/partials/head.ejs)
// -- without this, the applications page existed but nothing in the admin
// UI ever pointed to it, which was exactly why a submitted application
// could sit there indefinitely with no admin aware it existed. Computed
// once per admin request here rather than duplicated in every route that
// renders a page.
router.use((req, res, next) => {
  res.locals.pendingTrainerApplicationsCount = store.readAll("instructors")
    .filter((i) => i.signedRoePath && i.verificationStatus === "pending").length;
  next();
});

// Blogs and resources are general site content, not tied to any specific
// course — there's no "assigned course" concept that applies to them, so
// unlike course editing, scoping isn't the right model here. Restricted to
// super_admin rather than left open to any admin (course_admin included),
// which is what it was before this fix.
router.use("/blogs", auth.requireSuperAdmin);
router.use("/resources", auth.requireSuperAdmin);

// ---- My Account (password change) ----
// Deliberately available to every admin via requireAdmin above, not
// requireSuperAdmin like /settings — a course_admin needs to be able to
// change their own password just as much as a super_admin does. Reuses
// the same lockout tracker shape as login (failures only, per-IP) since
// this is the same class of risk: repeated wrong-password guesses against
// an account, just from an already-authenticated session rather than the
// public login form.
const changePasswordAttempts = security.createLoginAttemptTracker({
  windowMs: adminCfg.LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000,
  maxAttempts: adminCfg.LOGIN_MAX_ATTEMPTS,
});

router.get("/account", (req, res) => {
  res.render("admin/account", { title: "My Account — Baseline Skills", ...getAlerts(req) });
});

router.post("/account/change-password", (req, res) => {
  const attemptStatus = changePasswordAttempts.check(req);
  if (attemptStatus.blocked) {
    res.set("Retry-After", attemptStatus.retryAfterSeconds);
    return res.status(429).render("admin/account", {
      title: "My Account — Baseline Skills",
      error: "Too many failed attempts. Please wait 15 minutes and try again.",
    });
  }

  const { currentPassword, newPassword, confirmPassword } = req.body;
  const admin = store.findOne("admins", (a) => a.id === req.session.adminId);

  // Shouldn't be reachable — requireAdmin already confirmed a session exists
  // — but the admin row itself could have been deleted since the session
  // was created, so this is checked rather than assumed.
  if (!admin) {
    return res.status(401).render("admin/account", {
      title: "My Account — Baseline Skills",
      error: "Your session is no longer valid. Please log in again.",
    });
  }

  if (!auth.verifyPassword(currentPassword || "", admin.passwordHash)) {
    changePasswordAttempts.recordFailure(req);
    return res.status(400).render("admin/account", {
      title: "My Account — Baseline Skills",
      error: "Current password is incorrect.",
    });
  }

  if (!newPassword || newPassword.length < adminCfg.PASSWORD_MIN_LENGTH) {
    return res.status(400).render("admin/account", {
      title: "My Account — Baseline Skills",
      error: `New password must be at least ${adminCfg.PASSWORD_MIN_LENGTH} characters.`,
    });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).render("admin/account", {
      title: "My Account — Baseline Skills",
      error: "New password and confirmation don't match.",
    });
  }

  if (newPassword === currentPassword) {
    return res.status(400).render("admin/account", {
      title: "My Account — Baseline Skills",
      error: "New password must be different from your current password.",
    });
  }

  changePasswordAttempts.recordSuccess(req);
  store.update("admins", admin.id, { passwordHash: auth.hashPassword(newPassword) });
  res.redirect("/admin/account?success=Password+updated.");
});


// ---- Enhanced Dashboard & Visual Analytics ----
router.get("/", (req, res) => {
  const visibleCourseIds = auth.visibleCourseIdsFor(req);
  const isScoped = visibleCourseIds !== null;

  const allCourses = store.readAll("courses");
  const courses = isScoped ? allCourses.filter((c) => visibleCourseIds.includes(c.id)) : allCourses;
  const courseIdSet = new Set(courses.map((c) => c.id));

  const allRegistrations = store.readAll("registrations").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const registrations = isScoped ? allRegistrations.filter((r) => courseIdSet.has(r.courseId)) : allRegistrations;

  const allInquiries = store.readAll("inquiries").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // Inquiries aren't course-specific (general contact/corporate enquiries) —
  // a course_admin sees none of these rather than an arbitrary subset, since
  // there's no course to scope them by.
  const inquiries = isScoped ? [] : allInquiries;

  const confirmedRegs = registrations.filter((r) => r.status === "confirmed" || r.status === "invoice_pending");
  const revenueCents = confirmedRegs.reduce((sum, r) => sum + (r.priceCentsCharged || 0), 0);

  const statusCounts = registrations.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const allExams = store.readAll("certification_exams");
  const exams = isScoped ? allExams.filter((e) => courseIdSet.has(e.courseId)) : allExams;

  const allCertificates = store.readAll("certificates");
  const certificates = isScoped ? allCertificates.filter((c) => courseIdSet.has(c.courseId)) : allCertificates;

  const allFeedback = store.readAll("feedback");
  const feedback = isScoped ? allFeedback.filter((f) => courseIdSet.has(f.courseId)) : allFeedback;
  const feedbackSubmitted = feedback.filter((f) => f.rating !== null);

  // Commissions/trainers/affiliates/payouts are inherently cross-course
  // financial/HR data — Section 30's dashboard lists these, but they're
  // system-administrator territory the same way payout generation and
  // application review already are (Phase 7), not something a course_admin
  // sees a scoped slice of.
  let commissionSummary = null, trainerCount = null, affiliateCount = null, pendingPayoutCount = null;
  if (!isScoped) {
    const commissions = require("../lib/commissions");
    const totalCommissionCents = confirmedRegs.reduce((sum, r) => sum + commissions.calculateCommission(r).commissionCents, 0);
    commissionSummary = { totalCommissionCents };
    trainerCount = store.readAll("instructors").filter((i) => i.verificationStatus === "approved").length;
    affiliateCount = store.readAll("affiliates").filter((a) => a.status === "approved").length;
    pendingPayoutCount = store.readAll("payouts").filter((p) => p.status === "pending").length;
  }

  res.render("admin/dashboard", {
    title: "Admin dashboard — Baseline Skills",
    ...getAlerts(req),
    isScoped,
    courseCount: courses.length,
    publishedCount: courses.filter((c) => c.published).length,
    registrationCount: registrations.length,
    inquiryCount: inquiries.length,
    revenueDisplay: (revenueCents / 100).toFixed(2),
    statusCounts,
    recentRegistrations: registrations.slice(0, 8),
    recentInquiries: inquiries.slice(0, 5),
    examCount: exams.length,
    certificateCount: certificates.length,
    feedbackCount: feedback.length,
    feedbackSubmittedCount: feedbackSubmitted.length,
    commissionSummary, trainerCount, affiliateCount, pendingPayoutCount,
  });
});

// ---- Dynamic Data Export (CSV) ----
router.get("/export/:type", (req, res) => {
  const { type } = req.params;
  
  if (type === "registrations") {
    const visibleCourseIds = auth.visibleCourseIdsFor(req);
    const isScoped = visibleCourseIds !== null;
    let data = store.readAll("registrations");
    if (isScoped) data = data.filter((r) => visibleCourseIds.includes(r.courseId));
    if (req.query.courseId) data = data.filter((r) => r.courseId === req.query.courseId);
    if (req.query.status) data = data.filter((r) => r.status === req.query.status);

    // Every field Section 22 lists, not just the subset this export
    // originally had — phone/address are new fields (this phase);
    // certification-exam-purchased is derived from certificationExamId.
    let csv = "ID,Name,Email,Phone,Address,Course,Registration Date,Payment Status,Payment Amount,Certification Exam Purchased,Registration Status\n";
    data.forEach((r) => {
      const examPurchased = r.certificationExamId ? "Yes" : "No";
      csv += `"${r.id}","${r.name || ""}","${r.email || ""}","${r.phone || ""}","${(r.address || "").replace(/"/g, '""')}","${r.courseTitle || ""}","${r.createdAt}","${r.status || ""}","${((r.priceCentsCharged || 0) / 100).toFixed(2)}","${examPurchased}","${r.status || ""}"\n`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="registrations.csv"');
    return res.send(csv);
  }

  if (type === "feedback") {
    const visibleCourseIds = auth.visibleCourseIdsFor(req);
    const isScoped = visibleCourseIds !== null;
    let data = store.readAll("feedback");
    if (isScoped) data = data.filter((f) => visibleCourseIds.includes(f.courseId));
    if (req.query.courseId) data = data.filter((f) => f.courseId === req.query.courseId);
    if (req.query.stage) data = data.filter((f) => f.stage === req.query.stage);

    let csv = "ID,Course,Stage,Rating,Comment,Submitted\n";
    data.forEach((f) => {
      const course = store.findOne("courses", (c) => c.id === f.courseId);
      csv += `"${f.id}","${course ? course.title : ""}","${f.stage}","${f.rating == null ? "" : f.rating}","${(f.comment || "").replace(/"/g, '""')}","${f.rating != null ? "Yes" : "Pending"}"\n`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="feedback.csv"');
    return res.send(csv);
  }

  if (type === "inquiries") {
    // Inquiries are general contact/corporate enquiries, not tied to any
    // course — a course_admin has no course to scope them by, so they see
    // none, consistent with the dashboard's inquiryCount being 0 for them.
    if (auth.visibleCourseIdsFor(req) !== null) return res.status(403).send("Inquiries are not scoped to a course and aren't available to a course-scoped admin.");
    const data = store.readAll("inquiries");
    // Every field an inquiry can actually carry (Part 17: admin should be
    // able to inspect the full context) -- the previous version of this
    // export referenced i.subject, a field that has never existed on this
    // table, and omitted company/type/courseInterest/deliveryMode/
    // teamSize/preferredDates entirely despite all of them being real,
    // populated columns.
    let csv = "ID,Type,Name,Email,Company,Phone,Course,Delivery Mode,Participants,Preferred Dates,Message,Created At\n";
    data.forEach((i) => {
      csv += `"${i.id}","${i.type || ""}","${i.name || ""}","${i.email || ""}","${i.company || ""}","${i.phone || ""}","${i.courseInterest || ""}","${i.deliveryMode || ""}","${i.teamSize || ""}","${i.preferredDates || ""}","${(i.message || "").replace(/"/g, '""')}","${i.createdAt}"\n`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="inquiries.csv"');
    return res.send(csv);
  }

  res.status(400).send("Invalid export type");
});

// ---- Course list ----
router.get("/courses", (req, res) => {
  const visibleCourseIds = auth.visibleCourseIdsFor(req);
  let courses = store.readAll("courses");
  if (visibleCourseIds !== null) courses = courses.filter((c) => visibleCourseIds.includes(c.id));
  res.render("admin/courses-list", { 
    title: "Manage courses — Baseline Skills", 
    courses,
    ...getAlerts(req)
  });
});

// Replaces a course's additional-category rows with whatever was submitted
// this time — simplest correct way to handle add/remove/reorder from a
// plain textarea without tracking individual row diffs. The course's own
// primary `category` column is untouched by this; those are kept
// deliberately separate (see course_categories table comment).
// Accepts whatever shape a <select multiple> actually submits — nothing
// selected omits the field entirely (undefined), exactly one selection
// comes through as a plain string, more than one as an array. Normalizes
// all three to an array before use; no more newline-splitting now that
// this isn't a free-text textarea.
function syncAdditionalCategories(courseId, submitted) {
  store.readAll("course_categories").filter((cc) => cc.courseId === courseId).forEach((cc) => store.remove("course_categories", cc.id));
  const categories = submitted == null ? [] : (Array.isArray(submitted) ? submitted : [submitted]);
  categories.filter(Boolean).forEach((category) => {
    store.insert("course_categories", { id: newId("cc"), courseId, category });
  });
}

// The course-details form and the FAQ/exam-product/materials forms below
// it on the same admin page are separate <form> elements — HTML doesn't
// allow nesting one form inside another. A client-side script (see
// course-form.ejs) copies the course form's current field values into
// whichever of those secondary forms gets submitted, so any course-detail
// edits typed in but not yet saved travel along with it rather than being
// silently dropped (which looked like the edits had been "reverted" when
// really they were just never sent to the server at all). This is the
// server-side half: if those carried-along course fields are present,
// save the course first, before the route's own specific action runs.
// Detects "were the fields carried along" via req.body.title, since the
// course form's title field is always present and always non-empty
// (required) whenever this happens.
function saveCarriedCourseFieldsIfPresent(req) {
  if (!req.body || !req.body.course_title) return;
  const existing = store.findOne("courses", (c) => c.id === req.params.courseId);
  if (!existing) return;
  // Strip the "course_" prefix (see the comment in course-form.ejs on why
  // it's there) to rebuild a plain course-fields object — courseFromForm
  // has no idea these came from a differently-shaped request body.
  const courseBody = {};
  Object.keys(req.body).forEach((key) => {
    if (key.startsWith("course_")) courseBody[key.slice("course_".length)] = req.body[key];
  });
  const updated = courseFromForm(courseBody, existing, null); // null: never treat a FAQ/exam/material upload as a brochure replacement
  store.update("courses", req.params.courseId, updated);
  syncAdditionalCategories(req.params.courseId, courseBody.additionalCategories);
}

// Field-level validation for course create/edit — checked before any
// database write, not caught after the fact. Every free-text field's
// limit comes from config/business-rules.json's courseFieldLimits, not
// hardcoded here, matching how every other business rule in this app is
// kept admin-configurable. Returns an array of { field, message } — empty
// means the submission is valid. The slug-collision check exists because
// a real crash was found and reproduced: two titles differing only in
// punctuation ("Foo" vs "Foo!!!") slugify to the same value, and the
// second course's insert threw an uncaught SQLite UNIQUE constraint
// error with no validation catching it first.
function validateCourseFields(body, existingCourseId, existing) {
  const limits = discounts.loadConfig().courseFieldLimits;
  const errors = [];

  const checkRequired = (field, label, value) => {
    if (!value || !value.trim()) errors.push({ field, message: `${label} is required.` });
  };
  // Skips the length check entirely when the submitted value is identical
  // to what's already stored — these limits were introduced after courses
  // already existed, so an existing field longer than today's limit must
  // remain saveable as long as it isn't the thing being changed. existingValue
  // is the field reconstructed the same way the form textarea populates it
  // (array fields joined with "\n"), so the comparison is apples-to-apples.
  const checkMaxLength = (field, label, value, max, existingValue) => {
    if (existingValue !== undefined && (value || "").trim() === (existingValue || "").trim()) return;
    const len = (value || "").length;
    if (len > max) errors.push({ field, message: `${label} is ${len} characters — the maximum is ${max}.` });
  };

  checkRequired("title", "Title", body.title);
  checkMaxLength("title", "Title", body.title, limits.TITLE_MAX, existing && existing.title);

  // A category (or trainer, below) can be renamed or deleted by an admin
  // after courses already reference it. If that value is left completely
  // unchanged on this submission, rejecting it here would make the course
  // permanently un-editable for ANY future change, not just this field —
  // a real trap, not just a validation nicety. Only a submission that
  // actually changes this field to something new gets validated against
  // the current list; leaving it as-is always passes.
  const validCategories = store.readAll("categories").map((c) => c.name);
  const categoryUnchanged = existing && body.category === existing.category;
  if (!body.category || !body.category.trim()) {
    errors.push({ field: "category", message: "Category is required." });
  } else if (!categoryUnchanged && !validCategories.includes(body.category)) {
    errors.push({ field: "category", message: `"${body.category}" isn't a recognized category.` });
  }

  if (body.level && !["Beginner", "Intermediate", "Expert"].includes(body.level)) {
    errors.push({ field: "level", message: `Level must be Beginner, Intermediate, or Expert — got "${body.level}".` });
  }

  checkRequired("summary", "Summary", body.summary);
  checkMaxLength("summary", "Summary", body.summary, limits.SUMMARY_MAX, existing && existing.summary);

  checkRequired("description", "Description", body.description);
  checkMaxLength("description", "Description", body.description, limits.DESCRIPTION_MAX, existing && existing.description);

  checkMaxLength("outcomes", "Learning outcomes", body.outcomes, limits.OUTCOMES_MAX, existing && (existing.outcomes || []).join("\n"));
  checkMaxLength("audience", "Audience", body.audience, limits.AUDIENCE_MAX, existing && (existing.audience || []).join("\n"));
  checkMaxLength("prerequisites", "Prerequisites", body.prerequisites, limits.PREREQUISITES_MAX, existing && (existing.prerequisites || []).join("\n"));
  checkMaxLength("whatYoullReceive", "What you'll receive", body.whatYoullReceive, limits.WHAT_YOULL_RECEIVE_MAX, existing && (existing.whatYoullReceive || []).join("\n"));
  checkMaxLength("curriculumRaw", "Curriculum", body.curriculumRaw, limits.CURRICULUM_MAX, existing && (existing.curriculum || []).map((m) => `${m.module}: ${m.topics.join(", ")}`).join("\n"));
  checkMaxLength("formatAndMaterial", "Format & material", body.formatAndMaterial, limits.FORMAT_AND_MATERIAL_MAX, existing && existing.formatAndMaterial);
  checkMaxLength("practicalApplication", "How you'll use this at work", body.practicalApplication, limits.PRACTICAL_APPLICATION_MAX, existing && existing.practicalApplication);
  checkMaxLength("whyTakeThisCourse", "Why take this course", body.whyTakeThisCourse, limits.WHY_TAKE_THIS_COURSE_MAX, existing && existing.whyTakeThisCourse);

  const durationNum = Number(body.durationDays);
  if (!body.durationDays || !Number.isFinite(durationNum) || durationNum <= 0 || !Number.isInteger(durationNum)) {
    errors.push({ field: "durationDays", message: "Duration must be a whole number of days, greater than 0." });
  }

  const priceNum = Number(body.price);
  if (body.price === undefined || body.price === "" || !Number.isFinite(priceNum) || priceNum < 0) {
    errors.push({ field: "price", message: "Price must be a valid number, 0 or greater." });
  }

  if (body.legacyRatingAverage && body.legacyRatingAverage.trim()) {
    const legacyAvgNum = Number(body.legacyRatingAverage);
    if (!Number.isFinite(legacyAvgNum) || legacyAvgNum < 0 || legacyAvgNum > 5) {
      errors.push({ field: "legacyRatingAverage", message: "Legacy average rating must be a number between 0 and 5." });
    }
  }
  if (body.legacyRatingCount && body.legacyRatingCount.trim()) {
    const legacyCountNum = Number(body.legacyRatingCount);
    if (!Number.isFinite(legacyCountNum) || legacyCountNum < 0 || !Number.isInteger(legacyCountNum)) {
      errors.push({ field: "legacyRatingCount", message: "Legacy learner count must be a whole number, 0 or greater." });
    }
  }

  if (body.courseOutlineUrl && body.courseOutlineUrl.trim()) {
    checkMaxLength("courseOutlineUrl", "Course outline URL", body.courseOutlineUrl, limits.COURSE_OUTLINE_URL_MAX, existing && existing.courseOutlineUrl);
    if (!/^https?:\/\/.+/i.test(body.courseOutlineUrl.trim())) {
      errors.push({ field: "courseOutlineUrl", message: "Course outline URL must start with http:// or https://." });
    }
  }
  checkMaxLength("courseOutlineContent", "Course outline content", body.courseOutlineContent, limits.COURSE_OUTLINE_CONTENT_MAX, existing && existing.courseOutlineContent);

  // Same reasoning as category above — an unchanged trainer selection
  // always passes, even if that trainer has since been removed.
  const trainerUnchanged = existing && (body.trainerId || "") === (existing.trainerId || "");
  if (!trainerUnchanged && body.trainerId && body.trainerId.trim()) {
    const trainerExists = store.findOne("trainers", (t) => t.id === body.trainerId);
    if (!trainerExists) errors.push({ field: "trainerId", message: "Selected trainer doesn't exist." });
  }

  // Session rows — each repeated field is either a single string or an
  // array, exactly like the deliveryModes checkboxes; normalize both to
  // arrays the same way courseFromForm does, so validation checks the
  // same shape it will actually be building sessions from.
  const sessionStarts = Array.isArray(body.sessionStartDate) ? body.sessionStartDate : (body.sessionStartDate ? [body.sessionStartDate] : []);
  const sessionSeatsRaw = Array.isArray(body.sessionSeats) ? body.sessionSeats : (body.sessionSeats ? [body.sessionSeats] : []);
  // Same reasoning as category/trainer above — if the full set of session
  // start dates being submitted is identical to what the course already
  // has stored, none of them are actually being changed, so a format this
  // validation wouldn't otherwise accept (entered before this check
  // existed) shouldn't block saving an unrelated edit elsewhere on the form.
  const existingStartDates = existing ? (existing.sessions || []).map((s) => s.startDate).sort() : null;
  const submittedStartDatesSorted = sessionStarts.filter((s) => s && s.trim()).map((s) => s.trim()).sort();
  const sessionsUnchanged = existingStartDates && existingStartDates.length === submittedStartDatesSorted.length
    && existingStartDates.every((d, i) => d === submittedStartDatesSorted[i]);
  if (!sessionsUnchanged) {
    sessionStarts.forEach((s, i) => {
      if (!s || !s.trim()) return; // an empty "add a new session" row is fine, it's filtered out later
      if (s.trim().toLowerCase() !== "on demand" && !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) {
        errors.push({ field: "sessionStartDate", message: `Session ${i + 1} start date must be YYYY-MM-DD or "On Demand" — got "${s}".` });
      }
      const seats = sessionSeatsRaw[i];
      if (seats && seats.trim() && (!Number.isFinite(Number(seats)) || Number(seats) < 0)) {
        errors.push({ field: "sessionSeats", message: `Session ${i + 1} seats must be a non-negative number — got "${seats}".` });
      }
    });
  }

  // Slug collision — the crash this validation exists to prevent. Checked
  // against every OTHER course (excluding the one currently being
  // edited, which naturally already owns this exact slug).
  if (body.title && body.title.trim()) {
    const candidateSlug = slugify(body.title, { lower: true, strict: true });
    const collision = store.findOne("courses", (c) => c.slug === candidateSlug && c.id !== existingCourseId);
    if (collision) {
      errors.push({ field: "title", message: `This title produces the same URL slug ("${candidateSlug}") as an existing course ("${collision.title}"). Please choose a more distinct title.` });
    }
  }

  return errors;
}

// Rebuilds a properly-shaped course object for redisplaying the form
// after a failed save — never a naive spread of req.body over existing.
// req.body's array-backed fields (outcomes, audience, prerequisites,
// whatYoullReceive, additionalCategories) arrive as raw newline-joined
// strings or differently-shaped values from the form, not the arrays the
// template expects; a naive {...existing, ...req.body} spread overwrites
// a real array with a string, and the template's own .join('\n') call on
// it throws a SECOND, different error while rendering the failure page —
// which is exactly why a real save failure was showing the generic
// app-wide error page instead of this route's own specific message.
// courseFromForm already knows how to parse the form's raw shapes into
// the correct one; reusing it here (never actually persisting the
// result) keeps redisplay and real saves parsing identically by
// construction, so the two can never drift apart again.
function courseForRedisplay(body, existing) {
  try {
    return courseFromForm(body, existing || { id: newId("course") }, null);
  } catch (e) {
    console.error("[admin] courseForRedisplay failed, falling back to existing/raw body:", e.message);
    return existing || body;
  }
}

function courseFromForm(body, existing, uploadedFiles) {
  // uploadedFiles is req.files from multer's .fields() — {brochure:[file], courseOutline:[file]},
  // each key present only if that file was actually uploaded — or null/undefined
  // from callers (the FAQ/exam/materials carry-through, and courseForRedisplay)
  // that never handle file uploads at all, meaning "leave both exactly as they were."
  const brochureFile = uploadedFiles && uploadedFiles.brochure ? uploadedFiles.brochure[0] : null;
  const courseOutlineFile = uploadedFiles && uploadedFiles.courseOutline ? uploadedFiles.courseOutline[0] : null;
  const outcomes = (body.outcomes || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const audience = (body.audience || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const prerequisites = (body.prerequisites || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const whatYoullReceive = (body.whatYoullReceive || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const deliveryModes = Array.isArray(body.deliveryModes) ? body.deliveryModes : (body.deliveryModes ? [body.deliveryModes] : []);

  const curriculumRaw = (body.curriculumRaw || "").trim();
  const curriculum = curriculumRaw
    ? curriculumRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [modulePart, topicsPart] = line.split(":");
          return {
            module: (modulePart || "").trim(),
            topics: (topicsPart || "").split(",").map((t) => t.trim()).filter(Boolean),
          };
        })
        .filter((m) => m.module)
    : (existing ? existing.curriculum || [] : []);

  const sessionStarts = Array.isArray(body.sessionStartDate) ? body.sessionStartDate : [body.sessionStartDate].filter(Boolean);
  const sessionIds = Array.isArray(body.sessionId) ? body.sessionId : (body.sessionId !== undefined ? [body.sessionId] : []);
  const sessionEnds = Array.isArray(body.sessionEndDate) ? body.sessionEndDate : [body.sessionEndDate].filter(Boolean);
  const sessionTimeFroms = Array.isArray(body.sessionTimeFrom) ? body.sessionTimeFrom : [body.sessionTimeFrom].filter(Boolean);
  const sessionTimeTos = Array.isArray(body.sessionTimeTo) ? body.sessionTimeTo : [body.sessionTimeTo].filter(Boolean);
  const sessionModes = Array.isArray(body.sessionMode) ? body.sessionMode : [body.sessionMode].filter(Boolean);
  const sessionLocations = Array.isArray(body.sessionLocation) ? body.sessionLocation : [body.sessionLocation].filter(Boolean);
  const sessionSeats = Array.isArray(body.sessionSeats) ? body.sessionSeats : [body.sessionSeats].filter(Boolean);
  const sessions = sessionStarts
    .map((startDate, i) => ({
      id: sessionIds[i] || undefined, // present = update that existing row; absent = a newly added session row, insert
      startDate,
      endDate: sessionEnds[i] || "",
      timeFrom: sessionTimeFroms[i] || "",
      timeTo: sessionTimeTos[i] || "",
      mode: sessionModes[i] || deliveryModes[0] || "Live Online",
      // Optional (Section: meeting link visible only to registered
      // students) -- a plain URL or physical address, same field either
      // way; blank is fine, this isn't required for every session.
      location: sessionLocations[i] || "",
      seatsLeft: sessionSeats[i] ? Number(sessionSeats[i]) : null,
    }))
    .filter((s) => s.startDate);

  // Part 1/3: one delivery-option row per checked mode, priced
  // independently. Public modes read their own deliveryPrice_<Mode> field
  // (sanitized the same way the form names it -- see the EJS template);
  // left blank, priceCents is null here, and lib/pricing.js's own
  // fallback to the flat course price takes over at read time, rather
  // than this route needing to duplicate that fallback logic. Corporate
  // On-site/Private Cohort never read a price field at all -- Part 4 is
  // explicit that these have no public purchase price, so priceCents is
  // unconditionally null for them regardless of what might be posted.
  const inquiryOnlyModes = ["Corporate On-site", "Private Cohort"];
  const deliveryOptions = deliveryModes.map((mode) => {
    if (inquiryOnlyModes.includes(mode)) {
      return { deliveryMode: mode, priceCents: null, currency: body.currency || "EUR" };
    }
    const fieldName = `deliveryPrice_${mode.replace(/[^a-zA-Z]/g, "")}`;
    const raw = (body[fieldName] || "").toString().trim();
    return { deliveryMode: mode, priceCents: raw ? Math.round(Number(raw) * 100) : null, currency: body.currency || "EUR" };
  });

  // Part 8/9: the group-discount slab editor -- same array-of-parallel-
  // fields convention as sessions above. A row with no minParticipants
  // value is a blank "+ Add slab" row nobody filled in; dropped rather
  // than saved as a meaningless 0-to-0 slab.
  const groupRuleIds = Array.isArray(body.groupRuleId) ? body.groupRuleId : (body.groupRuleId !== undefined ? [body.groupRuleId] : []);
  const groupRuleMins = Array.isArray(body.groupRuleMin) ? body.groupRuleMin : (body.groupRuleMin !== undefined ? [body.groupRuleMin] : []);
  const groupRuleMaxes = Array.isArray(body.groupRuleMax) ? body.groupRuleMax : (body.groupRuleMax !== undefined ? [body.groupRuleMax] : []);
  const groupRulePercents = Array.isArray(body.groupRulePercent) ? body.groupRulePercent : (body.groupRulePercent !== undefined ? [body.groupRulePercent] : []);
  const groupDiscountRules = groupRuleMins
    .map((min, i) => ({
      id: groupRuleIds[i] || undefined,
      minParticipants: min,
      maxParticipants: groupRuleMaxes[i] || null,
      discountPercent: groupRulePercents[i],
    }))
    .filter((r) => r.minParticipants !== "" && r.minParticipants != null && r.discountPercent !== "" && r.discountPercent != null);

  return {
    ...existing,
    title: body.title,
    slug: existing && existing.slug ? existing.slug : slugify(body.title || "course", { lower: true, strict: true }),
    category: body.category,
    level: body.level || (existing ? existing.level : "Beginner"),
    imageUrl: body.imageUrl || (existing ? existing.imageUrl : ""),
    summary: body.summary,
    description: body.description,
    outcomes,
    curriculum: curriculum,
    audience,
    durationDays: Number(body.durationDays) || 1,
    deliveryModes: deliveryModes.length ? deliveryModes : ["Live Online"],
    priceCents: Math.round(Number(body.price || 0) * 100),
    discountPercent: Number(body.discountPercent || 0),
    currency: body.currency || "EUR",
    certification: !!body.certification,
    sessions,
    deliveryOptions,
    groupDiscountRules,
    corporateOnly: !!body.corporateOnly,
    published: !!body.published,
    courseOutlineUrl: body.courseOutlineUrl || "",
    trainerId: body.trainerId || "",
    whyTakeThisCourse: body.whyTakeThisCourse || "",
    prerequisites,
    formatAndMaterial: body.formatAndMaterial || "",
    practicalApplication: body.practicalApplication || "",
    whatYoullReceive,
    brochureFilename: brochureFile ? brochureFile.filename : (existing ? existing.brochureFilename : ""),
    courseOutlineFilename: courseOutlineFile ? courseOutlineFile.filename : (existing ? existing.courseOutlineFilename : ""),
    courseOutlineContent: body.courseOutlineContent || "",
    legacyRatingAverage: body.legacyRatingAverage && body.legacyRatingAverage.trim() ? Number(body.legacyRatingAverage) : null,
    legacyRatingCount: body.legacyRatingCount && body.legacyRatingCount.trim() ? Number(body.legacyRatingCount) : 0,
    createdAt: (existing && existing.createdAt) ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function handleCourseFileUploads(req, res, next) {
  courseFileUpload.fields([{ name: "brochure", maxCount: 1 }, { name: "courseOutline", maxCount: 1 }])(req, res, (err) => {
    if (!err) return next();
    const isEdit = req.params.id != null;
    const course = isEdit ? store.findOne("courses", (c) => c.id === req.params.id) : null;
    const knownMessages = ["Brochure must be a PDF file", "Course outline must be a PDF file"];
    res.status(400).render("admin/course-form", {
      title: isEdit ? `Edit ${course ? course.title : ""} — Baseline Skills` : "New course — Baseline Skills",
      course,
      mode: isEdit ? "edit" : "new",
      trainers: store.readAll("trainers"),
      categories: store.readAll("categories"),
      faqs: isEdit && course ? store.readAll("faqs").filter(f => f.scope === "course" && f.courseId === course.id).sort((a, b) => a.order - b.order) : [],
      examProduct: isEdit && course ? store.findOne("certification_exams", e => e.courseId === course.id) : null,
      materials: isEdit && course ? store.readAll("materials").filter(m => m.courseId === course.id) : [],
      courseDiscounts: isEdit && course ? store.readAll("course_discounts").filter(d => d.courseId === course.id) : [],
      error: knownMessages.includes(err.message) ? err.message : `File upload failed — please try a PDF under ${adminCfg.BROCHURE_MAX_FILE_SIZE_MB}MB.`,
    });
  });
}

function handleTrainerPhotoUpload(req, res, next) {
  trainerPhotoUpload.single("photo")(req, res, (err) => {
    if (!err) return next();
    const isEdit = req.params.id != null;
    const trainer = isEdit ? store.findOne("trainers", (t) => t.id === req.params.id) : null;
    res.status(400).render("admin/trainer-form", {
      title: isEdit ? `Edit ${trainer ? trainer.name : ""} — Baseline Skills` : "New trainer — Baseline Skills",
      trainer: isEdit ? { ...trainer, ...req.body } : req.body,
      mode: isEdit ? "edit" : "new",
      error: err.message === "Trainer photo must be a JPEG, PNG, or WebP image" ? err.message : `Photo upload failed — please try a JPEG, PNG, or WebP image under ${adminCfg.TRAINER_PHOTO_MAX_FILE_SIZE_MB}MB.`,
    });
  });
}
function handleResourceDownloadUpload(req, res, next) {
  resourceDownloadUpload.single("downloadFile")(req, res, (err) => {
    if (!err) return next();
    const isEdit = req.params.id != null;
    const resource = isEdit ? store.findOne("resources", (r) => r.id === req.params.id) : null;
    res.status(400).render("admin/resource-form", {
      title: isEdit ? `Edit ${resource ? resource.title : ""} — Baseline Skills` : "New resource — Baseline Skills",
      resource: isEdit ? resource : req.body,
      mode: isEdit ? "edit" : "new",
      error: err.message === "Resource download must be a PDF, Word, or Excel file" ? err.message : `File upload failed — please try a file under ${adminCfg.BROCHURE_MAX_FILE_SIZE_MB}MB.`,
    });
  });
}

router.get("/courses/new", (req, res) => {
  res.render("admin/course-form", { 
    title: "New course — Baseline Skills", 
    course: null, 
    mode: "new", 
    trainers: store.readAll("trainers"),
    categories: store.readAll("categories"),
    ...getAlerts(req)
  });
});

router.post("/courses/new", handleCourseFileUploads, (req, res) => {
  const errors = validateCourseFields(req.body, null);
  if (errors.length) {
    return res.status(400).render("admin/course-form", {
      title: "New course — Baseline Skills", course: courseForRedisplay(req.body, null), mode: "new",
      trainers: store.readAll("trainers"), categories: store.readAll("categories"),
      faqs: [], examProduct: null, materials: [], courseDiscounts: [],
      fieldErrors: errors, error: `${errors.length} field${errors.length !== 1 ? "s need" : " needs"} attention — see below.`,
    });
  }
  try {
    const course = courseFromForm(req.body, { id: newId("course") }, req.files);
    store.insert("courses", course);
    syncAdditionalCategories(course.id, req.body.additionalCategories);
    res.redirect("/admin/courses?success=Course+created+successfully");
  } catch (e) {
    console.error("[admin] course creation failed:", e.message, "\n", e.stack);
    res.status(500).render("admin/course-form", {
      title: "New course — Baseline Skills", course: courseForRedisplay(req.body, null), mode: "new",
      trainers: store.readAll("trainers"), categories: store.readAll("categories"),
      faqs: [], examProduct: null, materials: [], courseDiscounts: [],
      fieldErrors: [], error: `Something went wrong saving this course. Nothing was saved — please try again, and if this keeps happening, contact support with what you were entering. (Technical detail: ${e.message})`,
    });
  }
});

// ---- Edit course ----
router.get("/courses/:id/edit", auth.requireCourseAccess(r => r.params.id), (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (!course) return res.status(404).send("Course not found");
  course.additionalCategories = store.readAll("course_categories").filter((cc) => cc.courseId === course.id).map((cc) => cc.category);
  res.render("admin/course-form", { 
    title: `Edit ${course.title} — Baseline Skills`, 
    course, 
    mode: "edit", 
    trainers: store.readAll("trainers"),
    categories: store.readAll("categories"),
    faqs: store.readAll("faqs").filter(f => f.scope === "course" && f.courseId === course.id).sort((a, b) => a.order - b.order),
    examProduct: store.findOne("certification_exams", e => e.courseId === course.id),
    materials: store.readAll("materials").filter(m => m.courseId === course.id),
    courseDiscounts: store.readAll("course_discounts").filter(d => d.courseId === course.id),
    ...getAlerts(req)
  });
});

router.post("/courses/:id/edit", auth.requireCourseAccess(r => r.params.id), handleCourseFileUploads, (req, res) => {
  const existing = store.findOne("courses", (c) => c.id === req.params.id);
  if (!existing) return res.status(404).send("Course not found");
  const errors = validateCourseFields(req.body, req.params.id, existing);
  if (errors.length) {
    return res.status(400).render("admin/course-form", {
      title: `Edit ${existing.title} — Baseline Skills`, course: courseForRedisplay(req.body, existing), mode: "edit",
      trainers: store.readAll("trainers"), categories: store.readAll("categories"),
      faqs: store.readAll("faqs").filter(f => f.scope === "course" && f.courseId === existing.id).sort((a, b) => a.order - b.order),
      examProduct: store.findOne("certification_exams", e => e.courseId === existing.id),
      materials: store.readAll("materials").filter(m => m.courseId === existing.id),
      courseDiscounts: store.readAll("course_discounts").filter(d => d.courseId === existing.id),
      fieldErrors: errors, error: `${errors.length} field${errors.length !== 1 ? "s need" : " needs"} attention — see below.`,
    });
  }
  try {
    const updated = courseFromForm(req.body, existing, req.files);
    store.update("courses", req.params.id, updated);
    syncAdditionalCategories(req.params.id, req.body.additionalCategories);
    res.redirect("/admin/courses?success=Course+updated+successfully");
  } catch (e) {
    console.error(`[admin] course update failed for ${req.params.id}:`, e.message, "\n", e.stack);
    res.status(500).render("admin/course-form", {
      title: `Edit ${existing.title} — Baseline Skills`, course: courseForRedisplay(req.body, existing), mode: "edit",
      trainers: store.readAll("trainers"), categories: store.readAll("categories"),
      faqs: store.readAll("faqs").filter(f => f.scope === "course" && f.courseId === existing.id).sort((a, b) => a.order - b.order),
      examProduct: store.findOne("certification_exams", e => e.courseId === existing.id),
      materials: store.readAll("materials").filter(m => m.courseId === existing.id),
      courseDiscounts: store.readAll("course_discounts").filter(d => d.courseId === existing.id),
      fieldErrors: [], error: `Something went wrong saving this course. Nothing was changed — please try again, and if this keeps happening, contact support with what you were entering. (Technical detail: ${e.message})`,
    });
  }
});

router.post("/courses/:id/delete", auth.requireCourseAccess(r => r.params.id), (req, res) => {
  // Same orphaned-file risk as the LMS module-delete route: the FK cascade
  // (courses -> lms_modules -> lms_lessons -> lms_content_assets) correctly
  // removes every row, but has no idea those rows referenced real files on
  // disk. Cleaned up here before the cascade takes the rows that are the
  // only record of which files those were -- found this exact gap testing
  // the module-delete route, then checked (rather than assumed) that
  // course deletion had it too, since it cascades through the same tables.
  const { LMS_CONTENT_DIR } = require("../lib/lms-content-storage");
  const fs = require("fs");
  const modulesInCourse = store.readAll("lms_modules").filter((m) => m.courseId === req.params.id);
  const moduleIds = new Set(modulesInCourse.map((m) => m.id));
  const lessonsInCourse = store.readAll("lms_lessons").filter((l) => moduleIds.has(l.moduleId));
  lessonsInCourse.forEach((lesson) => {
    const asset = store.findOne("lms_content_assets", (a) => a.lessonId === lesson.id);
    if (asset) {
      const assetPath = path.join(LMS_CONTENT_DIR, asset.storageKey);
      if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
    }
  });
  store.remove("courses", req.params.id);
  res.redirect("/admin/courses?success=Course+deleted");
});

router.post("/courses/:id/toggle-published", auth.requireCourseAccess(r => r.params.id), (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (course) store.update("courses", req.params.id, { published: !course.published });
  res.redirect("/admin/courses?success=Status+updated");
});

// ==================== Course FAQs ====================
// ==================== Coupon Codes ====================
router.get("/vat-rates", auth.requireSuperAdmin, (req, res) => {
  const rates = store.readAll("vat_rates").sort((a, b) => a.countryCode.localeCompare(b.countryCode));
  res.render("admin/vat-rates", { title: "VAT Rates — Baseline Skills", rates, ...getAlerts(req) });
});

router.post("/vat-rates/new", auth.requireSuperAdmin, (req, res) => {
  const countryCode = (req.body.countryCode || "").trim().toUpperCase();
  const rate = Number(req.body.rate);
  const type = (req.body.type || "standard").trim();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return res.redirect("/admin/vat-rates?error=Country+code+must+be+a+2-letter+ISO+code+(e.g.+DE,+FR,+GB)");
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return res.redirect("/admin/vat-rates?error=Rate+must+be+a+percentage+between+0+and+100");
  }
  // countryCode is this table's own primary key -- an INSERT OR REPLACE
  // lets adding a rate for a country that already has one simply update
  // it, matching what an admin editing an existing rate actually expects,
  // rather than a duplicate-key error.
  store.raw.prepare(`INSERT OR REPLACE INTO vat_rates (countryCode, rate, type, effectiveFrom) VALUES (?, ?, ?, ?)`)
    .run(countryCode, rate, type, req.body.effectiveFrom || new Date().toISOString().slice(0, 10));
  res.redirect("/admin/vat-rates?success=VAT+rate+saved");
});

router.post("/vat-rates/:countryCode/delete", auth.requireSuperAdmin, (req, res) => {
  store.raw.prepare(`DELETE FROM vat_rates WHERE countryCode = ?`).run(req.params.countryCode.toUpperCase());
  res.redirect("/admin/vat-rates?success=VAT+rate+removed");
});

router.get("/coupons", (req, res) => {
  const coupons = store.readAll("coupon_codes").sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const courses = store.readAll("courses");
  const couponsWithCourseName = coupons.map((c) => ({
    ...c,
    courseName: c.courseId ? (courses.find((crs) => crs.id === c.courseId) || {}).title || "Unknown course" : "All courses",
  }));
  res.render("admin/coupons-list", {
    title: "Coupon Codes — Baseline Skills",
    coupons: couponsWithCourseName, courses,
    ...getAlerts(req),
  });
});

router.post("/coupons/new", auth.requireSuperAdmin, (req, res) => {
  const { code, percent, courseId, startDate, endDate } = req.body;
  if (!code || !code.trim()) return res.redirect("/admin/coupons?error=A+coupon+code+is+required");
  const percentNum = Number(percent);
  if (!Number.isFinite(percentNum) || percentNum <= 0 || percentNum > 100) {
    return res.redirect("/admin/coupons?error=Coupon+percent+must+be+between+1+and+100");
  }
  if (startDate && endDate && startDate > endDate) {
    return res.redirect("/admin/coupons?error=Coupon+start+date+must+be+before+its+end+date");
  }
  const normalizedCode = code.trim().toUpperCase();
  const existing = store.findOne("coupon_codes", (c) => c.code.toUpperCase() === normalizedCode);
  if (existing) return res.redirect("/admin/coupons?error=That+coupon+code+already+exists");
  store.insert("coupon_codes", {
    id: newId("coupon"), code: normalizedCode, percent: percentNum,
    courseId: courseId || null,
    startDate: startDate || null, endDate: endDate || null,
    active: 1, createdAt: new Date().toISOString(),
  });
  res.redirect("/admin/coupons?success=Coupon+code+created");
});

router.post("/coupons/:id/toggle-active", auth.requireSuperAdmin, (req, res) => {
  const coupon = store.findOne("coupon_codes", (c) => c.id === req.params.id);
  if (!coupon) return res.status(404).send("Coupon not found");
  store.update("coupon_codes", req.params.id, { active: coupon.active ? 0 : 1 });
  res.redirect("/admin/coupons?success=Coupon+updated");
});

router.post("/coupons/:id/delete", auth.requireSuperAdmin, (req, res) => {
  store.remove("coupon_codes", req.params.id);
  res.redirect("/admin/coupons?success=Coupon+deleted");
});

// ==================== Course Discounts ====================
router.post("/courses/:courseId/discounts/new", auth.requireCourseAccess(r => r.params.courseId), (req, res) => {
  saveCarriedCourseFieldsIfPresent(req);
  const { label, percent, startDate, endDate } = req.body;
  // Discounts are entirely optional — a blank percent means the admin
  // isn't adding one right now (the field is no longer required client-side
  // either, for the same reason). Course-level changes carried along via
  // saveCarriedCourseFieldsIfPresent above still get saved either way;
  // only creating the discount row itself is skipped.
  if (!percent || !percent.trim()) {
    return res.redirect(`/admin/courses/${req.params.courseId}/edit?success=Course+saved`);
  }
  const percentNum = Number(percent);
  if (!Number.isFinite(percentNum) || percentNum <= 0 || percentNum > 100) {
    return res.redirect(`/admin/courses/${req.params.courseId}/edit?error=Discount+percent+must+be+between+1+and+100`);
  }
  if (startDate && endDate && startDate > endDate) {
    return res.redirect(`/admin/courses/${req.params.courseId}/edit?error=Discount+start+date+must+be+before+its+end+date`);
  }
  store.insert("course_discounts", {
    id: newId("cdisc"), courseId: req.params.courseId,
    label: label || "", percent: percentNum,
    startDate: startDate || null, endDate: endDate || null,
    createdAt: new Date().toISOString(),
  });
  res.redirect(`/admin/courses/${req.params.courseId}/edit?success=Discount+added`);
});

router.post("/course-discounts/:id/delete", (req, res, next) => {
  const discount = store.findOne("course_discounts", d => d.id === req.params.id);
  if (!discount || !discount.courseId) return res.status(404).send("Discount not found");
  return auth.requireCourseAccess(() => discount.courseId)(req, res, next);
}, (req, res) => {
  const discount = store.findOne("course_discounts", d => d.id === req.params.id);
  store.remove("course_discounts", req.params.id);
  res.redirect(`/admin/courses/${discount.courseId}/edit?success=Discount+removed`);
});

router.post("/courses/:courseId/faqs/new", auth.requireCourseAccess(r => r.params.courseId), (req, res) => {
  saveCarriedCourseFieldsIfPresent(req);
  const { question, answer } = req.body;
  if (!question || !answer) return res.redirect(`/admin/courses/${req.params.courseId}/edit`);
  const existingCount = store.readAll("faqs").filter(f => f.courseId === req.params.courseId).length;
  store.insert("faqs", {
    id: newId("faq"), scope: "course", courseId: req.params.courseId,
    question, answer, order: existingCount, published: true, createdAt: new Date().toISOString(),
  });
  res.redirect(`/admin/courses/${req.params.courseId}/edit?success=FAQ+added`);
});

function requireFaqCourseAccess(req, res, next) {
  const faq = store.findOne("faqs", f => f.id === req.params.id);
  if (!faq || !faq.courseId) return res.status(404).send("FAQ not found");
  return auth.requireCourseAccess(() => faq.courseId)(req, res, next);
}

router.post("/faqs/:id/toggle-published", requireFaqCourseAccess, (req, res) => {
  const faq = store.findOne("faqs", f => f.id === req.params.id);
  store.update("faqs", req.params.id, { published: !faq.published });
  res.redirect(`/admin/courses/${faq.courseId}/edit`);
});

router.post("/faqs/:id/delete", requireFaqCourseAccess, (req, res) => {
  const faq = store.findOne("faqs", f => f.id === req.params.id);
  store.remove("faqs", req.params.id);
  res.redirect(`/admin/courses/${faq.courseId}/edit?success=FAQ+deleted`);
});

function moveFaq(direction) {
  return (req, res) => {
    const faq = store.findOne("faqs", f => f.id === req.params.id);
    const siblings = store.readAll("faqs").filter(f => f.courseId === faq.courseId).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex(f => f.id === faq.id);
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) return res.redirect(`/admin/courses/${faq.courseId}/edit`);
    const other = siblings[swapIndex];
    store.update("faqs", faq.id, { order: other.order });
    store.update("faqs", other.id, { order: faq.order });
    res.redirect(`/admin/courses/${faq.courseId}/edit`);
  };
}
router.post("/faqs/:id/move-up", requireFaqCourseAccess, moveFaq("up"));
router.post("/faqs/:id/move-down", requireFaqCourseAccess, moveFaq("down"));

// ==================== Certification Exam Products ====================
router.post("/courses/:courseId/certification-exams/new", auth.requireCourseAccess(r => r.params.courseId), (req, res) => {
  saveCarriedCourseFieldsIfPresent(req);
  const { certificationName, certificationBody, price, examProvider, description, eligibility } = req.body;
  if (!certificationName || !certificationBody || !price) return res.redirect(`/admin/courses/${req.params.courseId}/edit`);
  const priceCents = Math.round(Number(price) * 100);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    return res.redirect(`/admin/courses/${req.params.courseId}/edit?error=Exam+price+must+be+a+positive+amount`);
  }
  store.insert("certification_exams", {
    id: newId("exam"), courseId: req.params.courseId,
    certificationName, certificationBody, examName: certificationName,
    priceCents,
    description: description || "", eligibility: eligibility || "", examProvider: examProvider || "",
    availability: "available", createdAt: new Date().toISOString(),
  });
  res.redirect(`/admin/courses/${req.params.courseId}/edit?success=Exam+product+added`);
});

router.post("/certification-exams/:id/delete", (req, res, next) => {
  const exam = store.findOne("certification_exams", e => e.id === req.params.id);
  if (!exam || !exam.courseId) return res.status(404).send("Exam product not found");
  return auth.requireCourseAccess(() => exam.courseId)(req, res, next);
}, (req, res) => {
  const exam = store.findOne("certification_exams", e => e.id === req.params.id);
  store.remove("certification_exams", req.params.id);
  res.redirect(`/admin/courses/${exam.courseId}/edit?success=Exam+product+removed`);
});

// ==================== Course Materials ====================
router.post("/courses/:courseId/materials/new", auth.requireCourseAccess(r => r.params.courseId), materialUpload.single("file"), (req, res) => {
  saveCarriedCourseFieldsIfPresent(req);
  if (!req.file) return res.redirect(`/admin/courses/${req.params.courseId}/edit?error=No+file+selected`);
  store.insert("materials", {
    id: newId("material"), courseId: req.params.courseId,
    title: req.body.title || req.file.originalname,
    description: req.body.description || "",
    filePath: req.file.filename, fileType: req.file.mimetype,
    fileSizeBytes: req.file.size, createdAt: new Date().toISOString(),
  });
  res.redirect(`/admin/courses/${req.params.courseId}/edit?success=Material+uploaded`);
});

router.post("/materials/:id/delete", (req, res, next) => {
  const material = store.findOne("materials", m => m.id === req.params.id);
  if (!material || !material.courseId) return res.status(404).send("Material not found");
  return auth.requireCourseAccess(() => material.courseId)(req, res, next);
}, (req, res) => {
  const material = store.findOne("materials", m => m.id === req.params.id);
  const fs = require("fs");
  const filePath = path.join(MATERIAL_DIR, material.filePath);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  store.remove("materials", req.params.id);
  res.redirect(`/admin/courses/${material.courseId}/edit?success=Material+removed`);
});

// ---- Feedback report (Section 23) ----
router.get("/feedback", (req, res) => {
  const visibleCourseIds = auth.visibleCourseIdsFor(req);
  const isScoped = visibleCourseIds !== null;
  let feedback = store.readAll("feedback").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (isScoped) feedback = feedback.filter((f) => visibleCourseIds.includes(f.courseId));
  if (req.query.courseId) feedback = feedback.filter((f) => f.courseId === req.query.courseId);
  if (req.query.stage) feedback = feedback.filter((f) => f.stage === req.query.stage);

  const coursesById = {};
  store.readAll("courses").forEach((c) => { coursesById[c.id] = c; });
  const submitted = feedback.filter((f) => f.rating !== null);
  const avgRating = submitted.length ? (submitted.reduce((sum, f) => sum + f.rating, 0) / submitted.length) : null;

  const allCourses = store.readAll("courses");
  const filterCourses = isScoped ? allCourses.filter((c) => visibleCourseIds.includes(c.id)) : allCourses;

  res.render("admin/feedback", {
    title: "Feedback — Baseline Skills",
    feedback, coursesById, avgRating, submittedCount: submitted.length,
    filterCourses, activeCourseId: req.query.courseId || "", activeStage: req.query.stage || "",
    ...getAlerts(req),
  });
});

// ---- Bulk enroll candidates from a CSV ----
// Lets an admin enroll a batch of candidates into one published course
// (and, if it has sessions, one specific session) without each person
// going through checkout -- every candidate ends up as a real registration
// with status "confirmed" and priceCentsCharged: 0, then gets an email to
// set their password (or, if they already have a learner account, a plain
// notice) using the exact same /set-password token mechanism the public
// registration flow already uses, so there's no second login system to
// keep in sync.
router.get("/bulk-enroll", (req, res) => {
  const courses = store.readAll("courses").filter((c) => c.published);
  res.render("admin/bulk-enroll", { title: "Bulk Enroll Candidates — Baseline Skills", courses, result: null, error: null, ...getAlerts(req) });
});

router.get("/bulk-enroll/template.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="candidate-upload-template.csv"');
  res.send("Name,Email,Phone\n");
});

router.post("/bulk-enroll", (req, res, next) => {
  csvUpload.single("csvFile")(req, res, (err) => {
    if (err) return rerenderBulkEnroll(req, res, err.message);
    next();
  });
}, (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.body.courseId && c.published);
  if (!course) return rerenderBulkEnroll(req, res, "Please select a valid, published course.");

  let session = null;
  if (course.sessions && course.sessions.length > 0) {
    session = course.sessions.find((s) => s.id === req.body.sessionId);
    if (!session) return rerenderBulkEnroll(req, res, "Please select a session for this course.");
  }

  if (!req.file) return rerenderBulkEnroll(req, res, "Please choose a CSV file to upload.");

  let records;
  try {
    records = parseCsv(req.file.buffer.toString("utf8"), { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return rerenderBulkEnroll(req, res, "Could not read this CSV file — " + e.message);
  }
  if (records.length === 0) return rerenderBulkEnroll(req, res, "This CSV file has no data rows.");

  // Forgiving of header case/whitespace (an admin's spreadsheet export
  // might say "E-mail" or "email " rather than exactly "Email") rather
  // than requiring an exact match to the template's own header casing.
  function field(record, name) {
    const key = Object.keys(record).find((k) => k.trim().toLowerCase() === name);
    return key ? (record[key] || "").trim() : "";
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const existingRegistrations = store.readAll("registrations").filter((r) => r.courseId === course.id && r.status !== "cancelled");
  const seenInThisFile = new Set();
  const nowIso = new Date().toISOString();
  const appBaseUrl = process.env.APP_BASE_URL || "https://www.baselineskills.com";
  const result = { enrolled: [], skipped: [] };

  records.forEach((record, idx) => {
    const row = idx + 2; // 1-indexed, plus the header row itself
    const name = field(record, "name");
    const email = field(record, "email").toLowerCase();
    const phone = field(record, "phone");

    if (!name || !email) return result.skipped.push({ row, email, reason: "Missing name or email" });
    if (!emailPattern.test(email)) return result.skipped.push({ row, email, reason: "Invalid email address" });
    if (seenInThisFile.has(email)) return result.skipped.push({ row, email, reason: "Duplicate row in this file" });
    seenInThisFile.add(email);

    const alreadyRegistered = existingRegistrations.some((r) => r.email.toLowerCase() === email && (!session || r.sessionStartDate === session.startDate));
    if (alreadyRegistered) return result.skipped.push({ row, email, reason: "Already registered for this course" });

    // Same atomic hold-or-fail pattern the public registration flow uses
    // (routes/registration.js) -- a no-op for an unlimited-seats session
    // (seatsLeft null/undefined).
    if (session && session.seatsLeft !== null && session.seatsLeft !== undefined) {
      const seatUpdate = store.raw.prepare(`UPDATE sessions SET seatsLeft = seatsLeft - 1 WHERE id = ? AND seatsLeft >= 1`).run(session.id);
      if (seatUpdate.changes === 0) return result.skipped.push({ row, email, reason: "No seats left in this session" });
    }

    // Find-or-create learner -- the exact same pattern findOrCreateLearner
    // uses in routes/registration.js for a brand-new public registration,
    // so a CSV-enrolled candidate ends up completely indistinguishable
    // from one who registered and paid themselves.
    let learner = store.findOne("learners", (l) => l.email.toLowerCase() === email);
    let passwordSetToken = null;
    if (!learner) {
      passwordSetToken = crypto.randomBytes(32).toString("hex");
      learner = store.insert("learners", {
        id: newId("learner"), email, passwordHash: null, name, country: "", phone,
        passwordResetToken: passwordSetToken,
        passwordResetExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: nowIso,
      });
    }

    store.insert("registrations", {
      id: newId("reg"), courseId: course.id, courseTitle: course.title, learnerId: learner.id,
      name, email, phone,
      sessionStartDate: session ? session.startDate : null,
      deliveryMode: session ? session.mode : (course.deliveryModes && course.deliveryModes[0]) || "",
      priceCentsCharged: 0, currency: course.currency,
      status: "confirmed", isPurchaser: 1, participantCount: 1, grantsAccess: 1,
      createdAt: nowIso, confirmedAt: nowIso,
    });

    // Best-effort: a failed send shouldn't undo an otherwise-successful
    // enrollment, so this isn't awaited and isn't reflected in `result`.
    const setPasswordUrl = passwordSetToken ? `${appBaseUrl}/set-password?token=${passwordSetToken}` : null;
    sendMail({
      to: email,
      subject: `You're enrolled — ${course.title.replace(/[\r\n]/g, "")}`,
      html: `<p>Hi ${escapeHtml(name)},</p>
             <p>Baseline Skills has enrolled you in <strong>${escapeHtml(course.title)}</strong>${session ? ` (starting ${escapeHtml(session.startDate)})` : ""}.</p>
             ${setPasswordUrl
               ? `<p><a href="${setPasswordUrl}">Set your password</a> to access the course portal. Your login email is <strong>${escapeHtml(email)}</strong>.</p>`
               : `<p>Log in at <a href="${appBaseUrl}/login">${appBaseUrl}/login</a> with your existing email and password (<strong>${escapeHtml(email)}</strong>).</p>`}
             <p>We'll be in touch with joining instructions closer to the session date.</p>
             <p>— The Baseline Skills team</p>`,
    }).catch(() => {});

    result.enrolled.push({ row, name, email });
  });

  const courses = store.readAll("courses").filter((c) => c.published);
  res.render("admin/bulk-enroll", { title: "Bulk Enroll Candidates — Baseline Skills", courses, result, error: null });
});

function rerenderBulkEnroll(req, res, error) {
  const courses = store.readAll("courses").filter((c) => c.published);
  res.status(400).render("admin/bulk-enroll", { title: "Bulk Enroll Candidates — Baseline Skills", courses, result: null, error });
}

// ---- Registrations ----
router.get("/registrations", (req, res) => {
  const visibleCourseIds = auth.visibleCourseIdsFor(req);
  const isScoped = visibleCourseIds !== null;
  let registrations = store.readAll("registrations").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (isScoped) registrations = registrations.filter((r) => visibleCourseIds.includes(r.courseId));

  // Filtering, per Section 22 — by course and by status, the two most
  // useful cuts of this report for an admin looking for something specific
  // rather than scrolling every registration ever made.
  if (req.query.courseId) registrations = registrations.filter((r) => r.courseId === req.query.courseId);
  if (req.query.status) registrations = registrations.filter((r) => r.status === req.query.status);

  // Part 17: a group registration is now several rows in this same table
  // (one per participant) -- showing every one of them as its own line
  // would clutter the list with rows that charged nothing and paid
  // nobody. Collapsed here to one line per purchaser (or per standalone
  // registration, which is just a group of one and needs no collapsing),
  // with that group's participants attached for the view to show
  // alongside it — never dropped, just not each given their own row.
  const byGroupId = new Map();
  registrations.forEach((r) => {
    if (!r.groupRegistrationId) return;
    if (!byGroupId.has(r.groupRegistrationId)) byGroupId.set(r.groupRegistrationId, []);
    byGroupId.get(r.groupRegistrationId).push(r);
  });
  const displayRegistrations = registrations
    .filter((r) => !r.groupRegistrationId || r.isPurchaser)
    .map((r) => ({
      ...r,
      groupParticipants: r.groupRegistrationId ? (byGroupId.get(r.groupRegistrationId) || []).filter((p) => p.id !== r.id) : [],
    }));

  const completedPairs = new Set(store.readAll("certificates").map(c => `${c.learnerId}|${c.courseId}`));
  const allCourses = store.readAll("courses");
  const filterCourses = isScoped ? allCourses.filter((c) => visibleCourseIds.includes(c.id)) : allCourses;
  res.render("admin/registrations", { 
    title: "Registrations — Baseline Skills", 
    registrations: displayRegistrations,
    completedPairs,
    filterCourses,
    activeCourseId: req.query.courseId || "",
    activeStatus: req.query.status || "",
    ...getAlerts(req)
  });
});

// Marks a registration's course as completed for the learner, issuing a
// real certificate + badge — only meaningful for a genuinely confirmed
// registration (a course you never actually paid for/confirmed can't be
// "completed"), and only when the registration has a real learnerId (an
// anonymous registration that was never linked to an account has no one to
// issue a certificate to).
router.post("/registrations/:id/complete", (req, res, next) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  return auth.requireCourseAccess(() => reg.courseId)(req, res, next);
}, async (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  if (reg.status !== "confirmed" && reg.status !== "invoice_pending") {
    return res.redirect("/admin/registrations?error=Only+a+confirmed+registration+can+be+marked+complete");
  }
  if (!reg.learnerId) {
    return res.redirect("/admin/registrations?error=This+registration+has+no+linked+learner+account");
  }
  store.insert("enrollment_progress", {
    id: newId("progress"), learnerId: reg.learnerId, courseId: reg.courseId,
    percentComplete: 100, completedAt: new Date().toISOString(),
  });
  await certificates.issueCertificate({ learnerId: reg.learnerId, courseId: reg.courseId, appBaseUrl: `${req.protocol}://${req.get("host")}` });

  // Course-completion-stage feedback prompt — a real row the learner can
  // later fill in via their account page, not just a stage label with
  // nothing behind it.
  const existingFeedback = store.findOne("feedback", (f) => f.learnerId === reg.learnerId && f.courseId === reg.courseId && f.stage === "course_completion");
  if (!existingFeedback) {
    store.insert("feedback", {
      id: newId("feedback"), learnerId: reg.learnerId, courseId: reg.courseId,
      sessionId: null, moduleId: null, stage: "course_completion",
      rating: null, comment: null, structuredAnswers: null, createdAt: new Date().toISOString(),
    });
  }

  res.redirect("/admin/registrations?success=Course+marked+complete+—+certificate+issued");
});

// Force-regenerates an already-issued certificate + badge from the current
// layout code -- for exactly the case backfillCertificates deliberately
// never touches: a real, existing PDF from before a later design fix.
router.post("/registrations/:id/regenerate-certificate", (req, res, next) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  return auth.requireCourseAccess(() => reg.courseId)(req, res, next);
}, async (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  const cert = store.findOne("certificates", (c) => c.learnerId === reg.learnerId && c.courseId === reg.courseId);
  if (!cert) return res.redirect("/admin/registrations?error=No+certificate+has+been+issued+for+this+registration+yet");
  await certificates.regenerateCertificateFiles(cert.id, `${req.protocol}://${req.get("host")}`);
  res.redirect("/admin/registrations?success=Certificate+and+badge+regenerated");
});

// Invoice-pending → confirmed, for when a registration was recorded via
// the no-payment-provider fallback (or an offline/bank-transfer invoice)
// and payment has now genuinely been received. Reuses finalizeRegistration
// itself -- the exact same function the Paddle/PayPal webhooks and the
// fallback path already call -- rather than a second, separate
// "mark confirmed" implementation that could drift out of sync with it:
// this gets the same group-cascade (every sibling registration in the
// same group is confirmed together, Part 13), the same real invoice
// generation (skipped for the fallback path, generated here since this
// is a genuine payment confirmation), and the same confirmation emails a
// live webhook would have sent, for free.
router.post("/registrations/:id/mark-paid", (req, res, next) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  return auth.requireCourseAccess(() => reg.courseId)(req, res, next);
}, async (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  if (reg.status !== "invoice_pending") {
    return res.redirect("/admin/registrations?error=Only+an+invoice-pending+registration+can+be+marked+as+paid");
  }
  await finalizeRegistration(reg.id, {});
  res.redirect("/admin/registrations?success=Registration+marked+as+paid+—+confirmation+sent");
});

// Manual counterpart to the automatic reconciliation check in the resume
// flow (see reconcileExistingOrder in registration.js) — covers a
// registration stuck at pending_payment that the customer never actually
// retried, which the automatic check has no reason to ever run for.
// Lets an admin confirm directly with the provider whether money was
// actually taken, rather than guessing from the registration's own status
// alone, which is exactly what can't be trusted here.
router.post("/registrations/:id/check-payment-status", (req, res, next) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  return auth.requireCourseAccess(() => reg.courseId)(req, res, next);
}, async (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  if (reg.status !== "pending_payment") {
    return res.redirect("/admin/registrations?error=Only+a+pending-payment+registration+can+be+checked+this+way");
  }
  const orderIdField = orderIdFieldFor(reg.paymentProvider);
  const orderId = reg[orderIdField];
  if (!reg.paymentProvider || !orderId) {
    return res.redirect("/admin/registrations?error=This+registration+has+no+payment+order+on+record+to+check");
  }
  try {
    const result = await payments.getOrderStatus(reg.paymentProvider, orderId);
    if (!result.supported) {
      return res.redirect(`/admin/registrations?error=Payment+status+lookup+isn%27t+supported+for+${reg.paymentProvider}+yet`);
    }
    if (result.captured) {
      await finalizeRegistration(reg.id, { viaFallback: false });
      return res.redirect("/admin/registrations?success=Provider+confirms+this+was+already+paid+%E2%80%94+registration+confirmed");
    }
    return res.redirect(`/admin/registrations?error=Provider+reports+this+order+as+"${encodeURIComponent(result.status || "unknown")}"+%E2%80%94+not+yet+captured`);
  } catch (err) {
    console.error(`[admin] payment status check failed for ${reg.id}:`, err.message);
    return res.redirect("/admin/registrations?error=Could+not+reach+the+payment+provider+right+now+%E2%80%94+try+again+shortly");
  }
});


// releases the seat(s) their submission reserved — see
// cancelRegistrationGroup in registration.js for why a partial
// (single-participant) cancellation deliberately does NOT touch seats or
// siblings. This is the first admin-facing way to release a seat at all;
// previously the only actions were complete, regenerate-certificate, and
// mark-paid, so a stuck pending_payment or an unwanted confirmed
// registration had no way to free its seat back to the session.
router.post("/registrations/:id/cancel", (req, res, next) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  return auth.requireCourseAccess(() => reg.courseId)(req, res, next);
}, async (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.id);
  if (!reg) return res.status(404).send("Registration not found");
  if (reg.status === "cancelled" || reg.status === "refunded") {
    return res.redirect("/admin/registrations?error=That+registration+is+already+cancelled");
  }
  cancelRegistrationGroup(reg.id);
  const message = reg.isPurchaser ? "Registration+cancelled+and+its+seat(s)+released" : "Registration+cancelled";
  res.redirect(`/admin/registrations?success=${message}`);
});

// ==================== LMS Access Diagnostic ====================
// A support tool for exactly this kind of ticket -- "this student can't
// see their course" -- checking every condition isEnrolled() and the LMS
// dashboard/course-player routes actually depend on, in one place, rather
// than an admin (or Claude, working from a support message with no direct
// database access) having to reason through the access-control chain by
// hand each time. Read-only; changes nothing.
router.get("/lms-access-check", auth.requireSuperAdmin, (req, res) => {
  const email = (req.query.email || "").trim();
  const courseQuery = (req.query.course || "").trim();
  const allCourses = store.readAll("courses").sort((a, b) => a.title.localeCompare(b.title));

  let report = null;
  if (email && courseQuery) {
    const course = store.findOne("courses", (c) => c.id === courseQuery || c.slug === courseQuery)
      || allCourses.find((c) => c.title.toLowerCase() === courseQuery.toLowerCase());
    const learner = store.findOne("learners", (l) => l.email.toLowerCase() === email.toLowerCase());
    const registrations = store.readAll("registrations").filter((r) =>
      course && (r.courseId === course.id) &&
      (r.email.toLowerCase() === email.toLowerCase() || (learner && r.learnerId === learner.id))
    );
    const modules = course ? store.readAll("lms_modules").filter((m) => m.courseId === course.id) : [];
    const moduleIds = new Set(modules.map((m) => m.id));
    const lessons = store.readAll("lms_lessons").filter((l) => moduleIds.has(l.moduleId));
    const publishedLessons = lessons.filter((l) => l.isPublished);
    const windowStatus = course ? lmsAccess.courseAccessWindowStatus(course) : null;
    const isEnrolledResult = learner && course ? lmsAccess.isEnrolled(learner.id, course.id) : false;

    // Every asset a published lesson actually needs to serve (video/PDF/
    // document/presentation) is checked against the real filesystem, not
    // just the database record -- a lesson can be correctly published,
    // with a correct asset row, and still be unviewable if the file
    // itself isn't where the current storage configuration expects it
    // (e.g. an asset uploaded before a storage-path change, or DATA_DIR
    // pointing somewhere different than when it was uploaded).
    const publishedLessonIds = new Set(publishedLessons.map((l) => l.id));
    const assets = store.readAll("lms_content_assets").filter((a) => publishedLessonIds.has(a.lessonId));
    const assetChecks = assets.map((a) => {
      const filePath = path.join(LMS_CONTENT_DIR, a.storageKey);
      const lesson = publishedLessons.find((l) => l.id === a.lessonId);
      return { lessonTitle: lesson ? lesson.title : "(unknown lesson)", storageKey: a.storageKey, exists: fs.existsSync(filePath), filePath };
    });

    report = {
      courseFound: !!course, course,
      learnerFound: !!learner, learner,
      registrations,
      modulesCount: modules.length, lessonsCount: lessons.length, publishedLessonsCount: publishedLessons.length,
      windowStatus, isEnrolledResult,
      assetChecks, lmsContentDir: LMS_CONTENT_DIR, dataDirSet: !!process.env.DATA_DIR,
    };
  }

  res.render("admin/lms-access-check", {
    title: "LMS Access Check — Baseline Skills",
    allCourses, email, courseQuery, report,
  });
});

// ==================== Trainer & Affiliate Applications ====================
router.get("/trainer-applications", auth.requireSuperAdmin, (req, res) => {
  const applications = store.readAll("instructors").filter(i => i.signedRoePath).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/onboarding-applications", { title: "Trainer Applications — Baseline Skills", applications, type: "trainer", ...getAlerts(req) });
});

router.post("/trainer-applications/:id/approve", auth.requireSuperAdmin, (req, res) => {
  const instructor = store.findOne("instructors", i => i.id === req.params.id);
  if (!instructor) return res.status(404).send("Application not found");
  store.update("instructors", instructor.id, { verificationStatus: "approved" });
  const existingCode = store.findOne("referral_codes", r => r.ownerType === "instructor" && r.ownerId === instructor.id);
  if (!existingCode) {
    // Simplification, documented explicitly: this code applies site-wide
    // (courseScope: null) rather than being restricted to only courses this
    // instructor teaches. Properly scoping it to their own course(s)
    // specifically — and handling an instructor who teaches more than
    // one — is deferred; the commission calculation still correctly rates
    // any sale referred via this code at the instructor-referred tier
    // regardless of which course it's for.
    store.insert("referral_codes", {
      id: newId("refcode"), ownerType: "instructor", ownerId: instructor.id,
      code: `TR-${instructor.id.slice(-8).toUpperCase()}`, courseScope: null,
      validFrom: new Date().toISOString(), validTo: null,
    });
  }
  res.redirect("/admin/trainer-applications?success=Trainer+approved");
});

router.post("/trainer-applications/:id/reject", auth.requireSuperAdmin, (req, res) => {
  const instructor = store.findOne("instructors", i => i.id === req.params.id);
  if (!instructor) return res.status(404).send("Application not found");
  store.update("instructors", instructor.id, { verificationStatus: "rejected", rejectionReason: req.body.reason || "" });
  res.redirect("/admin/trainer-applications?success=Application+rejected");
});

router.get("/affiliate-applications", auth.requireSuperAdmin, (req, res) => {
  const applications = store.readAll("affiliates").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/onboarding-applications", { title: "Affiliate Applications — Baseline Skills", applications, type: "affiliate", ...getAlerts(req) });
});

router.post("/affiliate-applications/:id/approve", auth.requireSuperAdmin, (req, res) => {
  const affiliate = store.findOne("affiliates", a => a.id === req.params.id);
  if (!affiliate) return res.status(404).send("Application not found");
  store.update("affiliates", affiliate.id, { status: "approved" });
  const existingCode = store.findOne("referral_codes", r => r.ownerType === "affiliate" && r.ownerId === affiliate.id);
  if (!existingCode) {
    store.insert("referral_codes", {
      id: newId("refcode"), ownerType: "affiliate", ownerId: affiliate.id,
      code: `AF-${affiliate.id.slice(-8).toUpperCase()}`, courseScope: null,
      validFrom: new Date().toISOString(), validTo: null,
    });
  }
  res.redirect("/admin/affiliate-applications?success=Affiliate+approved");
});

router.post("/affiliate-applications/:id/reject", auth.requireSuperAdmin, (req, res) => {
  const affiliate = store.findOne("affiliates", a => a.id === req.params.id);
  if (!affiliate) return res.status(404).send("Application not found");
  store.update("affiliates", affiliate.id, { status: "rejected", rejectionReason: req.body.reason || "" });
  res.redirect("/admin/affiliate-applications?success=Application+rejected");
});

// ==================== Payouts ====================
router.get("/payouts", auth.requireSuperAdmin, (req, res) => {
  const payouts = store.readAll("payouts").sort((a, b) => new Date(b.periodEnd) - new Date(a.periodEnd));
  const recipientName = (p) => {
    const recipient = p.recipientType === "instructor"
      ? store.findOne("instructors", (i) => i.id === p.recipientId)
      : store.findOne("affiliates", (a) => a.id === p.recipientId);
    return recipient ? recipient.name : "Unknown";
  };
  const instructors = store.readAll("instructors").filter((i) => i.verificationStatus === "approved");
  const affiliates = store.readAll("affiliates").filter((a) => a.status === "approved");
  res.render("admin/payouts", { title: "Payouts — Baseline Skills", payouts, recipientName, instructors, affiliates, ...getAlerts(req) });
});

router.post("/payouts/generate", auth.requireSuperAdmin, (req, res) => {
  const { recipientType, recipientId, periodStart, periodEnd } = req.body;
  if (!recipientType || !recipientId || !periodStart || !periodEnd) {
    return res.redirect("/admin/payouts?error=All+fields+are+required");
  }
  const result = payoutsLib.generatePayout({ recipientType, recipientId, periodStart, periodEnd });
  if (!result.created) {
    return res.redirect(`/admin/payouts?error=${encodeURIComponent(result.reason)}`);
  }
  res.redirect(`/admin/payouts?success=Payout+generated+—+$${(result.payout.totalAmountCents/100).toFixed(2)}`);
});

router.get("/payouts/:id", auth.requireSuperAdmin, (req, res) => {
  const payout = store.findOne("payouts", (p) => p.id === req.params.id);
  if (!payout) return res.status(404).send("Payout not found");
  const recipient = payout.recipientType === "instructor"
    ? store.findOne("instructors", (i) => i.id === payout.recipientId)
    : store.findOne("affiliates", (a) => a.id === payout.recipientId);
  const lineItems = store.readAll("payout_line_items").filter((li) => li.payoutId === payout.id).map((li) => ({
    ...li, registration: store.findOne("registrations", (r) => r.id === li.registrationId),
  }));
  res.render("admin/payout-detail", { title: "Payout Detail — Baseline Skills", payout, recipient, lineItems, ...getAlerts(req) });
});

router.post("/payouts/:id/mark-processed", auth.requireSuperAdmin, (req, res) => {
  const payout = store.findOne("payouts", (p) => p.id === req.params.id);
  if (!payout) return res.status(404).send("Payout not found");
  store.update("payouts", payout.id, { status: "processed", paidAt: new Date().toISOString() });
  res.redirect(`/admin/payouts/${payout.id}?success=Marked+as+processed`);
});

router.post("/payouts/:id/mark-failed", auth.requireSuperAdmin, (req, res) => {
  const payout = store.findOne("payouts", (p) => p.id === req.params.id);
  if (!payout) return res.status(404).send("Payout not found");
  store.update("payouts", payout.id, { status: "failed" });
  res.redirect(`/admin/payouts/${payout.id}?success=Marked+as+failed`);
});

// ---- Inquiries (contact + corporate) ----
router.get("/inquiries", (req, res) => {
  const inquiries = store.readAll("inquiries").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/inquiries", { 
    title: "Inquiries — Baseline Skills", 
    inquiries,
    ...getAlerts(req)
  });
});

// ==================== Site Settings ====================
// Homepage statistics and other business-level facts that are true numbers,
// not calculated from live data (a rating average or learner count *could*
// be computed from the database, but "trained 20,000+ professionals since
// 2009" reflects the company's full history, most of which predates this
// system's own records — so this is intentionally a configurable value an
// admin can update, not a hardcoded string in the homepage template.
const HOMEPAGE_SETTING_KEYS = [
  { key: "stat_founded_year", label: "Training since (year)", default: "2009" },
  { key: "stat_average_rating", label: "Average course rating", default: "4.8" },
  { key: "stat_professionals_trained", label: "Professionals trained", default: "20,000+" },
  { key: "stat_industries_served", label: "Industries served", default: "10+" },
];

router.get("/settings", auth.requireSuperAdmin, (req, res) => {
  const settings = HOMEPAGE_SETTING_KEYS.map((s) => ({ ...s, value: store.getSetting(s.key, s.default) }));
  res.render("admin/settings", { title: "Site Settings — Baseline Skills", settings, ...getAlerts(req) });
});

router.post("/settings", auth.requireSuperAdmin, (req, res) => {
  HOMEPAGE_SETTING_KEYS.forEach((s) => {
    if (typeof req.body[s.key] === "string" && req.body[s.key].trim()) {
      store.setSetting(s.key, req.body[s.key].trim());
    }
  });
  res.redirect("/admin/settings?success=Settings+updated");
});

// ==================== Trainers ====================
// A trainer is visible/manageable by this admin if either the admin is
// unrestricted (super_admin), or the trainer teaches at least one course
// the admin is assigned to — trainers aren't assigned directly, so
// visibility is derived through the courses they teach, the same
// relationship admin_course_assignments already encodes.
function trainerIsVisibleTo(req, trainerId) {
  const visibleCourseIds = auth.visibleCourseIdsFor(req);
  if (visibleCourseIds === null) return true;
  return store.readAll("courses").some((c) => c.trainerId === trainerId && visibleCourseIds.includes(c.id));
}

router.get("/trainers", (req, res) => {
  const visibleCourseIds = auth.visibleCourseIdsFor(req);
  let trainers = store.readAll("trainers");
  if (visibleCourseIds !== null) {
    const teachingIds = new Set(store.readAll("courses").filter((c) => visibleCourseIds.includes(c.id) && c.trainerId).map((c) => c.trainerId));
    trainers = trainers.filter((t) => teachingIds.has(t.id));
  }
  res.render("admin/trainers-list", { 
    title: "Manage trainers — Baseline Skills", 
    trainers,
    isScoped: visibleCourseIds !== null,
    ...getAlerts(req)
  });
});

router.get("/trainers/new", auth.requireSuperAdmin, (req, res) => {
  res.render("admin/trainer-form", { 
    title: "New trainer — Baseline Skills", 
    trainer: null, 
    mode: "new",
    ...getAlerts(req)
  });
});

router.post("/trainers/new", auth.requireSuperAdmin, handleTrainerPhotoUpload, (req, res) => {
  const { name, title, bio, profileUrl, workExperienceRaw } = req.body;
  const email = (req.body.email || "").trim().toLowerCase() || null;
  const password = req.body.password || "";
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: "New trainer — Baseline Skills", trainer: req.body, mode: "new",
      error: "Name and profile link are required.",
    });
  }
  if (password && password.length < adminCfg.PASSWORD_MIN_LENGTH) {
    return res.status(400).render("admin/trainer-form", {
      title: "New trainer — Baseline Skills", trainer: req.body, mode: "new",
      error: `Password must be at least ${adminCfg.PASSWORD_MIN_LENGTH} characters, or leave it blank.`,
    });
  }
  // instructors.email is UNIQUE -- checked explicitly here rather than
  // letting a raw constraint violation surface as an unhandled 500, the
  // same lesson learned from the isLate crash earlier in this project:
  // never assume a write will succeed just because the request looked
  // valid on the surface.
  if (email && store.findOne("instructors", (i) => i.email && i.email.toLowerCase() === email)) {
    return res.status(400).render("admin/trainer-form", {
      title: "New trainer — Baseline Skills", trainer: req.body, mode: "new",
      error: "That email is already in use by another trainer/instructor account.",
    });
  }
  const workExperience = (workExperienceRaw || "").split("\n").map((s) => s.trim()).filter(Boolean);
  store.insert("trainers", {
    id: newId("trainer"), name, title: title || "", bio: bio || "", profileUrl, email,
    passwordHash: password ? auth.hashPassword(password) : null,
    photoPath: req.file ? `/trainer-photo/${req.file.filename}` : "",
    workExperience,
    // An admin directly creating this record is a different situation
    // from the self-service "become a trainer" application flow, which
    // correctly starts at the 'pending' default awaiting review --
    // here, the admin's own action *is* the approval, so a trainer given
    // login credentials this way isn't left unable to sign in despite
    // having valid ones, mirroring exactly the login gate at
    // /trainer/login that also checks verificationStatus.
    verificationStatus: email ? "approved" : "pending",
    createdAt: new Date().toISOString(),
  });
  res.redirect("/admin/trainers?success=Trainer+added");
});

router.get("/trainers/:id/edit", (req, res) => {
  const trainer = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!trainer) return res.status(404).send("Trainer not found");
  if (!trainerIsVisibleTo(req, trainer.id)) return res.status(403).send("You don't have access to this trainer.");
  res.render("admin/trainer-form", { 
    title: `Edit ${trainer.name} — Baseline Skills`, 
    trainer, 
    mode: "edit",
    ...getAlerts(req)
  });
});

router.post("/trainers/:id/edit", handleTrainerPhotoUpload, (req, res) => {
  const existing = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!existing) return res.status(404).send("Trainer not found");
  if (!trainerIsVisibleTo(req, existing.id)) return res.status(403).send("You don't have access to this trainer.");
  const { name, title, bio, profileUrl, workExperienceRaw } = req.body;
  const email = (req.body.email || "").trim().toLowerCase() || null;
  const password = req.body.password || "";
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: `Edit ${existing.name} — Baseline Skills`, trainer: { ...existing, ...req.body }, mode: "edit",
      error: "Name and profile link are required.",
    });
  }
  if (password && password.length < adminCfg.PASSWORD_MIN_LENGTH) {
    return res.status(400).render("admin/trainer-form", {
      title: `Edit ${existing.name} — Baseline Skills`, trainer: { ...existing, ...req.body }, mode: "edit",
      error: `Password must be at least ${adminCfg.PASSWORD_MIN_LENGTH} characters, or leave it blank to keep the current one.`,
    });
  }
  if (email && email !== (existing.email || "").toLowerCase() &&
      store.findOne("instructors", (i) => i.id !== existing.id && i.email && i.email.toLowerCase() === email)) {
    return res.status(400).render("admin/trainer-form", {
      title: `Edit ${existing.name} — Baseline Skills`, trainer: { ...existing, ...req.body }, mode: "edit",
      error: "That email is already in use by another trainer/instructor account.",
    });
  }
  const workExperience = (workExperienceRaw || "").split("\n").map((s) => s.trim()).filter(Boolean);
  store.update("trainers", req.params.id, {
    name, title: title || "", bio: bio || "", profileUrl, email,
    // Blank means "leave unchanged" here, not "clear it" -- an admin
    // fixing a typo in a trainer's title shouldn't accidentally wipe out
    // a password that was already set, unlike email above, where a
    // blank submission genuinely does mean "no email on file."
    passwordHash: password ? auth.hashPassword(password) : existing.passwordHash,
    photoPath: req.file ? `/trainer-photo/${req.file.filename}` : existing.photoPath,
    workExperience,
    // Retroactively unblocks exactly the situation this was built for:
    // an existing trainer profile with a public bio but no login at
    // all, still sitting at the 'pending' default it was created with
    // before it ever had an email. Adding an email here now is the
    // admin's own act of granting access, the same reasoning as on
    // creation -- but only when it wasn't already approved, so an
    // admin correcting a typo in an already-approved trainer's email
    // doesn't need to re-trigger anything.
    verificationStatus: (email && existing.verificationStatus !== "approved") ? "approved" : existing.verificationStatus,
  });
  res.redirect("/admin/trainers?success=Trainer+updated");
});

router.post("/trainers/:id/delete", (req, res) => {
  if (!trainerIsVisibleTo(req, req.params.id)) return res.status(403).send("You don't have access to this trainer.");
  const referencingCourses = store.readAll("courses").filter((c) => c.trainerId === req.params.id);
  if (referencingCourses.length) {
    // Mirrors GET /trainers' own scoping exactly (see that route above) —
    // this render was written as a standalone shortcut that only ever
    // passed {title, trainers, error}, omitting isScoped, which the
    // template references directly with no typeof guard
    // (admin/trainers-list.ejs lines 6 and 8). That's an unconditional
    // crash — not just for a restricted admin, for ANY admin hitting this
    // path — reproduced as exactly the "deletion gives an error" bug
    // report: deleting a trainer who's still assigned to a course doesn't
    // show the intended "reassign those courses first" message, it 500s
    // instead. Also wasn't scoping the trainers list down for a
    // restricted admin the way the real route does, a second, smaller
    // drift from the same root cause (a hand-copied shortcut render
    // instead of reusing the real route's logic).
    const visibleCourseIds = auth.visibleCourseIdsFor(req);
    let trainers = store.readAll("trainers");
    if (visibleCourseIds !== null) {
      const teachingIds = new Set(store.readAll("courses").filter((c) => visibleCourseIds.includes(c.id) && c.trainerId).map((c) => c.trainerId));
      trainers = trainers.filter((t) => teachingIds.has(t.id));
    }
    return res.status(400).render("admin/trainers-list", {
      title: "Manage trainers — Baseline Skills",
      trainers,
      isScoped: visibleCourseIds !== null,
      error: `Can't delete — this trainer is assigned to ${referencingCourses.length} course(s): ${referencingCourses.map((c) => c.title).join(", ")}. Reassign those courses first.`,
    });
  }
  store.remove("trainers", req.params.id);
  res.redirect("/admin/trainers?success=Trainer+deleted");
});

// ==================== Categories ====================
router.get("/categories", (req, res) => {
  const categories = store.readAll("categories").sort((a, b) => a.name.localeCompare(b.name));
  const courses = store.readAll("courses");
  const additional = store.readAll("course_categories");
  // How many courses currently use each category, as either their
  // primary category or an additional one — shown so an admin can see
  // the impact before trying to delete one.
  const usageCount = {};
  categories.forEach((cat) => {
    const primary = courses.filter((c) => c.category === cat.name).length;
    const extra = additional.filter((cc) => cc.category === cat.name).length;
    usageCount[cat.id] = primary + extra;
  });
  res.render("admin/categories-list", {
    title: "Manage categories — Baseline Skills",
    categories, usageCount,
    ...getAlerts(req),
  });
});

router.post("/categories/new", auth.requireSuperAdmin, (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) {
    return res.redirect("/admin/categories?error=Category+name+is+required");
  }
  const existing = store.findOne("categories", (c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return res.redirect("/admin/categories?error=That+category+already+exists");
  }
  store.insert("categories", { id: newId("cat"), name, createdAt: new Date().toISOString() });
  res.redirect("/admin/categories?success=Category+added");
});

router.post("/categories/:id/delete", auth.requireSuperAdmin, (req, res) => {
  const category = store.findOne("categories", (c) => c.id === req.params.id);
  if (!category) return res.status(404).send("Category not found");
  const primaryCount = store.readAll("courses").filter((c) => c.category === category.name).length;
  const additionalCount = store.readAll("course_categories").filter((cc) => cc.category === category.name).length;
  const total = primaryCount + additionalCount;
  if (total > 0) {
    return res.redirect(`/admin/categories?error=Can't+delete+"${encodeURIComponent(category.name)}"+—+${total}+course(s)+still+use+it.+Reassign+those+courses+first.`);
  }
  store.remove("categories", req.params.id);
  res.redirect("/admin/categories?success=Category+deleted");
});

// ==================== Blogs ====================
router.get("/blogs", (req, res) => {
  const blogs = store.readAll("blogs").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/blogs-list", { 
    title: "Manage blog posts — Baseline Skills", 
    blogs,
    ...getAlerts(req)
  });
});

function blogFromForm(body, existing) {
  return {
    ...existing,
    title: body.title,
    slug: existing && existing.slug ? existing.slug : slugify(body.title || "post", { lower: true, strict: true }),
    excerpt: body.excerpt,
    body: body.body,
    author: body.author || "Baseline Skills Team",
    category: body.category || "Requirements Engineering",
    published: !!body.published,
    updatedAt: new Date().toISOString(),
  };
}

router.get("/blogs/new", (req, res) => {
  res.render("admin/blog-form", { 
    title: "New blog post — Baseline Skills", 
    blog: null, 
    mode: "new",
    ...getAlerts(req)
  });
});

router.post("/blogs/new", (req, res) => {
  if (!req.body.title || !req.body.body) {
    return res.status(400).render("admin/blog-form", { title: "New blog post — Baseline Skills", blog: req.body, mode: "new", error: "Title and body are required." });
  }
  const blog = blogFromForm(req.body, { id: newId("blog"), createdAt: new Date().toISOString() });
  store.insert("blogs", blog);
  res.redirect("/admin/blogs?success=Blog+post+published");
});

router.get("/blogs/:id/edit", (req, res) => {
  const blog = store.findOne("blogs", (b) => b.id === req.params.id);
  if (!blog) return res.status(404).send("Blog post not found");
  res.render("admin/blog-form", { 
    title: `Edit ${blog.title} — Baseline Skills`, 
    blog, 
    mode: "edit",
    ...getAlerts(req)
  });
});

router.post("/blogs/:id/edit", (req, res) => {
  const existing = store.findOne("blogs", (b) => b.id === req.params.id);
  if (!existing) return res.status(404).send("Blog post not found");
  if (!req.body.title || !req.body.body) {
    return res.status(400).render("admin/blog-form", { title: `Edit ${existing.title} — Baseline Skills`, blog: { ...existing, ...req.body }, mode: "edit", error: "Title and body are required." });
  }
  const updated = blogFromForm(req.body, existing);
  store.update("blogs", req.params.id, updated);
  res.redirect("/admin/blogs?success=Blog+post+updated");
});

router.post("/blogs/:id/delete", (req, res) => {
  store.remove("blogs", req.params.id);
  res.redirect("/admin/blogs?success=Blog+post+deleted");
});

router.post("/blogs/:id/toggle-published", (req, res) => {
  const blog = store.findOne("blogs", (b) => b.id === req.params.id);
  if (blog) store.update("blogs", req.params.id, { published: !blog.published });
  res.redirect("/admin/blogs?success=Status+updated");
});

// ==================== Resources ====================
router.get("/resources", (req, res) => {
  const resources = store.readAll("resources").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/resources-list", { 
    title: "Manage resources — Baseline Skills", 
    resources,
    ...getAlerts(req)
  });
});

router.get("/resources/new", (req, res) => {
  res.render("admin/resource-form", { 
    title: "New resource — Baseline Skills", 
    resource: null, 
    mode: "new",
    ...getAlerts(req)
  });
});

router.post("/resources/new", handleResourceDownloadUpload, (req, res) => {
  const { title, category, excerpt, body, url } = req.body;
  if (!title || !excerpt || (!body && !url)) {
    return res.status(400).render("admin/resource-form", { title: "New resource — Baseline Skills", resource: req.body, mode: "new", error: "Title, excerpt, and either article content or an external link are required." });
  }
  store.insert("resources", {
    id: newId("res"),
    slug: slugify(title, { lower: true, strict: true }),
    title, category: category || "Requirements Engineering", excerpt, body: body || null, url: url || null,
    downloadFilename: req.file ? req.file.filename : "",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  res.redirect("/admin/resources?success=Resource+created");
});

router.get("/resources/:id/edit", (req, res) => {
  const resource = store.findOne("resources", (r) => r.id === req.params.id);
  if (!resource) return res.status(404).send("Resource not found");
  res.render("admin/resource-form", { 
    title: `Edit ${resource.title} — Baseline Skills`, 
    resource, 
    mode: "edit",
    ...getAlerts(req)
  });
});

router.post("/resources/:id/edit", handleResourceDownloadUpload, (req, res) => {
  const existing = store.findOne("resources", (r) => r.id === req.params.id);
  if (!existing) return res.status(404).send("Resource not found");
  const { title, category, excerpt, body, url } = req.body;
  if (!title || !excerpt || (!body && !url)) {
    return res.status(400).render("admin/resource-form", { title: `Edit ${existing.title} — Baseline Skills`, resource: { ...existing, ...req.body }, mode: "edit", error: "Title, excerpt, and either article content or an external link are required." });
  }
  store.update("resources", req.params.id, { title, category: category || existing.category, excerpt, body: body || null, url: url || null, downloadFilename: req.file ? req.file.filename : existing.downloadFilename, updatedAt: new Date().toISOString() });
  res.redirect("/admin/resources?success=Resource+updated");
});

router.post("/resources/:id/delete", (req, res) => {
  store.remove("resources", req.params.id);
  res.redirect("/admin/resources?success=Resource+deleted");
});

module.exports = router;
