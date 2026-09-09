const express = require("express");
const router = express.Router();
const path = require("path");
const store = require("../lib/db");
const auth = require("../lib/auth");
const security = require("../lib/security");
const certificates = require("../lib/certificates");
const payoutsLib = require("../lib/payouts");
const discounts = require("../lib/discounts");
const adminCfg = discounts.loadConfig().security;
const { newId } = require("../lib/id");
const slugify = require("slugify");
const createRateLimiter = require("../lib/rate-limiter");
const multer = require("multer");
const { BROCHURE_DIR } = require("../lib/brochures");
const { MATERIAL_DIR } = require("../lib/materials");

const materialUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MATERIAL_DIR),
    filename: (req, file, cb) => cb(null, `${newId("material")}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: adminCfg.MATERIAL_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

const brochureUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BROCHURE_DIR),
    filename: (req, file, cb) => cb(null, `${newId("brochure")}.pdf`),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Brochure must be a PDF file"));
    }
    cb(null, true);
  },
  limits: { fileSize: adminCfg.BROCHURE_MAX_FILE_SIZE_MB * 1024 * 1024 },
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

// Blogs and resources are general site content, not tied to any specific
// course — there's no "assigned course" concept that applies to them, so
// unlike course editing, scoping isn't the right model here. Restricted to
// super_admin rather than left open to any admin (course_admin included),
// which is what it was before this fix.
router.use("/blogs", auth.requireSuperAdmin);
router.use("/resources", auth.requireSuperAdmin);


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
    let csv = "ID,Name,Email,Subject,Message,Created At\n";
    data.forEach((i) => {
      csv += `"${i.id}","${i.name || ""}","${i.email || ""}","${i.subject || ""}","${(i.message || "").replace(/"/g, '""')}","${i.createdAt}"\n`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="inquiries.csv"');
    return res.send(csv);
  }

  res.status(400).send("Invalid export type");
});

// ---- Course list ----
router.get("/courses", (req, res) => {
  const courses = store.readAll("courses");
  res.render("admin/courses-list", { 
    title: "Manage courses — Baseline Skills", 
    courses,
    ...getAlerts(req)
  });
});

function courseFromForm(body, existing, uploadedFile) {
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
  const sessionEnds = Array.isArray(body.sessionEndDate) ? body.sessionEndDate : [body.sessionEndDate].filter(Boolean);
  const sessionTimeFroms = Array.isArray(body.sessionTimeFrom) ? body.sessionTimeFrom : [body.sessionTimeFrom].filter(Boolean);
  const sessionTimeTos = Array.isArray(body.sessionTimeTo) ? body.sessionTimeTo : [body.sessionTimeTo].filter(Boolean);
  const sessionModes = Array.isArray(body.sessionMode) ? body.sessionMode : [body.sessionMode].filter(Boolean);
  const sessionSeats = Array.isArray(body.sessionSeats) ? body.sessionSeats : [body.sessionSeats].filter(Boolean);
  const sessions = sessionStarts
    .map((startDate, i) => ({
      startDate,
      endDate: sessionEnds[i] || "",
      timeFrom: sessionTimeFroms[i] || "",
      timeTo: sessionTimeTos[i] || "",
      mode: sessionModes[i] || deliveryModes[0] || "Live Online",
      seatsLeft: sessionSeats[i] ? Number(sessionSeats[i]) : null,
    }))
    .filter((s) => s.startDate);

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
    currency: body.currency || "USD",
    certification: !!body.certification,
    sessions,
    corporateOnly: !!body.corporateOnly,
    published: !!body.published,
    courseOutlineUrl: body.courseOutlineUrl || "",
    trainerId: body.trainerId || "",
    whyTakeThisCourse: body.whyTakeThisCourse || "",
    prerequisites,
    formatAndMaterial: body.formatAndMaterial || "",
    whatYoullReceive,
    brochureFilename: uploadedFile ? uploadedFile.filename : (existing ? existing.brochureFilename : ""),
    createdAt: (existing && existing.createdAt) ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function handleBrochureUpload(req, res, next) {
  brochureUpload.single("brochure")(req, res, (err) => {
    if (!err) return next();
    const isEdit = req.params.id != null;
    const course = isEdit ? store.findOne("courses", (c) => c.id === req.params.id) : null;
    res.status(400).render("admin/course-form", {
      title: isEdit ? `Edit ${course ? course.title : ""} — Baseline Skills` : "New course — Baseline Skills",
      course,
      mode: isEdit ? "edit" : "new",
      trainers: store.readAll("trainers"),
      faqs: isEdit && course ? store.readAll("faqs").filter(f => f.scope === "course" && f.courseId === course.id).sort((a, b) => a.order - b.order) : [],
      examProduct: isEdit && course ? store.findOne("certification_exams", e => e.courseId === course.id) : null,
      materials: isEdit && course ? store.readAll("materials").filter(m => m.courseId === course.id) : [],
      error: err.message === "Brochure must be a PDF file" ? err.message : `Brochure upload failed — please try a PDF under ${adminCfg.BROCHURE_MAX_FILE_SIZE_MB}MB.`,
    });
  });
}

router.get("/courses/new", (req, res) => {
  res.render("admin/course-form", { 
    title: "New course — Baseline Skills", 
    course: null, 
    mode: "new", 
    trainers: store.readAll("trainers"),
    ...getAlerts(req)
  });
});

router.post("/courses/new", handleBrochureUpload, (req, res) => {
  const course = courseFromForm(req.body, { id: newId("course") }, req.file);
  store.insert("courses", course);
  res.redirect("/admin/courses?success=Course+created+successfully");
});

// ---- Edit course ----
router.get("/courses/:id/edit", auth.requireCourseAccess(r => r.params.id), (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (!course) return res.status(404).send("Course not found");
  res.render("admin/course-form", { 
    title: `Edit ${course.title} — Baseline Skills`, 
    course, 
    mode: "edit", 
    trainers: store.readAll("trainers"),
    faqs: store.readAll("faqs").filter(f => f.scope === "course" && f.courseId === course.id).sort((a, b) => a.order - b.order),
    examProduct: store.findOne("certification_exams", e => e.courseId === course.id),
    materials: store.readAll("materials").filter(m => m.courseId === course.id),
    ...getAlerts(req)
  });
});

router.post("/courses/:id/edit", auth.requireCourseAccess(r => r.params.id), handleBrochureUpload, (req, res) => {
  const existing = store.findOne("courses", (c) => c.id === req.params.id);
  if (!existing) return res.status(404).send("Course not found");
  const updated = courseFromForm(req.body, existing, req.file);
  store.update("courses", req.params.id, updated);
  res.redirect("/admin/courses?success=Course+updated+successfully");
});

router.post("/courses/:id/delete", auth.requireCourseAccess(r => r.params.id), (req, res) => {
  store.remove("courses", req.params.id);
  res.redirect("/admin/courses?success=Course+deleted");
});

router.post("/courses/:id/toggle-published", auth.requireCourseAccess(r => r.params.id), (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (course) store.update("courses", req.params.id, { published: !course.published });
  res.redirect("/admin/courses?success=Status+updated");
});

// ==================== Course FAQs ====================
router.post("/courses/:courseId/faqs/new", auth.requireCourseAccess(r => r.params.courseId), (req, res) => {
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

  const completedPairs = new Set(store.readAll("certificates").map(c => `${c.learnerId}|${c.courseId}`));
  const allCourses = store.readAll("courses");
  const filterCourses = isScoped ? allCourses.filter((c) => visibleCourseIds.includes(c.id)) : allCourses;
  res.render("admin/registrations", { 
    title: "Registrations — Baseline Skills", 
    registrations,
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

router.post("/trainers/new", auth.requireSuperAdmin, (req, res) => {
  const { name, title, bio, profileUrl } = req.body;
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: "New trainer — Baseline Skills", trainer: req.body, mode: "new",
      error: "Name and profile link are required.",
    });
  }
  store.insert("trainers", {
    id: newId("trainer"), name, title: title || "", bio: bio || "", profileUrl,
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

router.post("/trainers/:id/edit", (req, res) => {
  const existing = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!existing) return res.status(404).send("Trainer not found");
  if (!trainerIsVisibleTo(req, existing.id)) return res.status(403).send("You don't have access to this trainer.");
  const { name, title, bio, profileUrl } = req.body;
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: `Edit ${existing.name} — Baseline Skills`, trainer: { ...existing, ...req.body }, mode: "edit",
      error: "Name and profile link are required.",
    });
  }
  store.update("trainers", req.params.id, { name, title: title || "", bio: bio || "", profileUrl });
  res.redirect("/admin/trainers?success=Trainer+updated");
});

router.post("/trainers/:id/delete", (req, res) => {
  if (!trainerIsVisibleTo(req, req.params.id)) return res.status(403).send("You don't have access to this trainer.");
  const referencingCourses = store.readAll("courses").filter((c) => c.trainerId === req.params.id);
  if (referencingCourses.length) {
    const trainers = store.readAll("trainers");
    return res.status(400).render("admin/trainers-list", {
      title: "Manage trainers — Baseline Skills",
      trainers,
      error: `Can't delete — this trainer is assigned to ${referencingCourses.length} course(s): ${referencingCourses.map((c) => c.title).join(", ")}. Reassign those courses first.`,
    });
  }
  store.remove("trainers", req.params.id);
  res.redirect("/admin/trainers?success=Trainer+deleted");
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

router.post("/resources/new", (req, res) => {
  const { title, category, excerpt, body, url } = req.body;
  if (!title || !excerpt || (!body && !url)) {
    return res.status(400).render("admin/resource-form", { title: "New resource — Baseline Skills", resource: req.body, mode: "new", error: "Title, excerpt, and either article content or an external link are required." });
  }
  store.insert("resources", {
    id: newId("res"),
    slug: slugify(title, { lower: true, strict: true }),
    title, category: category || "Requirements Engineering", excerpt, body: body || null, url: url || null,
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

router.post("/resources/:id/edit", (req, res) => {
  const existing = store.findOne("resources", (r) => r.id === req.params.id);
  if (!existing) return res.status(404).send("Resource not found");
  const { title, category, excerpt, body, url } = req.body;
  if (!title || !excerpt || (!body && !url)) {
    return res.status(400).render("admin/resource-form", { title: `Edit ${existing.title} — Baseline Skills`, resource: { ...existing, ...req.body }, mode: "edit", error: "Title, excerpt, and either article content or an external link are required." });
  }
  store.update("resources", req.params.id, { title, category: category || existing.category, excerpt, body: body || null, url: url || null, updatedAt: new Date().toISOString() });
  res.redirect("/admin/resources?success=Resource+updated");
});

router.post("/resources/:id/delete", (req, res) => {
  store.remove("resources", req.params.id);
  res.redirect("/admin/resources?success=Resource+deleted");
});

module.exports = router;
