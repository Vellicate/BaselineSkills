const express = require("express");
const router = express.Router();
const multer = require("multer");
const store = require("../lib/db");
const auth = require("../lib/auth");
const security = require("../lib/security");
const commissions = require("../lib/commissions");
const { newId } = require("../lib/id");
const { ROE_UPLOAD_DIR } = require("../lib/onboarding");
const createRateLimiter = require("../lib/rate-limiter");
const discounts = require("../lib/discounts");

router.use(security.requireSameOrigin);

const onboardingCfg = discounts.loadConfig().security;

router.use((req, res, next) => { res.locals.passwordMinLength = onboardingCfg.PASSWORD_MIN_LENGTH; next(); });

const trainerLoginAttempts = security.createLoginAttemptTracker({ windowMs: onboardingCfg.LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000, maxAttempts: onboardingCfg.LOGIN_MAX_ATTEMPTS });
const affiliateLoginAttempts = security.createLoginAttemptTracker({ windowMs: onboardingCfg.LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000, maxAttempts: onboardingCfg.LOGIN_MAX_ATTEMPTS });

const applicationRateLimiter = createRateLimiter({
  windowMs: onboardingCfg.ONBOARDING_APPLICATION_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000, max: onboardingCfg.ONBOARDING_APPLICATION_RATE_LIMIT_MAX, keyPrefix: "onboarding_apply",
  message: `Too many applications submitted. Please wait ${onboardingCfg.ONBOARDING_APPLICATION_RATE_LIMIT_WINDOW_MINUTES} minutes.`,
});

const roeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ROE_UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${newId("roe")}.pdf`),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") return cb(new Error("Signed document must be a PDF"));
    cb(null, true);
  },
  limits: { fileSize: onboardingCfg.ROE_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

// Wraps roeUpload so a bad file (wrong type or too large) re-renders the
// application form with a clean message, the same way handleBrochureUpload
// already does for course brochures — found missing here (an oversized or
// wrong-type file crashed with a raw Multer stack trace instead) while
// testing the file-size limits added during the configuration audit.
function handleRoeUpload(viewName) {
  return (req, res, next) => {
    roeUpload.single("signedRoe")(req, res, (err) => {
      if (!err) return next();
      const error = err.message === "Signed document must be a PDF"
        ? err.message
        : `Signed document upload failed — please try a PDF under ${onboardingCfg.ROE_MAX_FILE_SIZE_MB}MB.`;
      res.status(400).render(viewName, { title: viewName === "become-a-trainer" ? "Become a Trainer — Baseline Skills" : "Become an Affiliate — Baseline Skills", error });
    });
  };
}

// ==================== Become a Trainer / Teach with Us ====================
// "Teach with Us" is the same underlying application flow as the original
// "Become a Trainer" page, not a separate system — /teach-with-us is now the
// primary URL (matching the new nav label), with the old path redirecting to
// it rather than serving duplicate content at two URLs.
router.get("/teach-with-us", (req, res) => {
  res.render("become-a-trainer", { title: "Teach with Us — Baseline Skills", error: null });
});
router.get("/become-a-trainer", (req, res) => res.redirect(301, "/teach-with-us"));

router.post("/become-a-trainer/apply", applicationRateLimiter, handleRoeUpload("become-a-trainer"), (req, res) => {
  const { name, email, password, title, bio, profileUrl } = req.body;
  if (!name || !email || !password || !req.file) {
    return res.status(400).render("become-a-trainer", { title: "Become a Trainer — Baseline Skills", error: "Name, email, password, and the signed Rules of Engagement PDF are all required." });
  }
  if (password.length < onboardingCfg.PASSWORD_MIN_LENGTH) {
    return res.status(400).render("become-a-trainer", { title: "Become a Trainer — Baseline Skills", error: `Password must be at least ${onboardingCfg.PASSWORD_MIN_LENGTH} characters.` });
  }
  const existing = store.findOne("instructors", (i) => i.email && i.email.toLowerCase() === email.toLowerCase());
  if (existing && existing.verificationStatus !== "rejected") {
    return res.status(400).render("become-a-trainer", { title: "Become a Trainer — Baseline Skills", error: "An application or account with that email already exists." });
  }

  let instructor;
  if (existing) {
    // A previously rejected applicant can reapply — update the existing
    // record rather than block permanently, which the original check did
    // by treating any existing row (rejected or not) as a hard stop.
    instructor = store.update("instructors", existing.id, {
      passwordHash: auth.hashPassword(password),
      name, title: title || "", bio: bio || "", profileUrl: profileUrl || "",
      verificationStatus: "pending", signedRoePath: req.file.filename, rejectionReason: null,
    });
  } else {
    instructor = store.insert("instructors", {
      id: newId("instructor"), email: email.toLowerCase(), passwordHash: auth.hashPassword(password),
      name, title: title || "", bio: bio || "", profileUrl: profileUrl || "",
      verificationStatus: "pending", signedRoePath: req.file.filename, createdAt: new Date().toISOString(),
    });
  }
  store.insert("roe_acknowledgments", {
    id: newId("roeack"), recipientType: "instructor", recipientId: instructor.id,
    sentAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString(),
  });

  res.render("application-submitted", { title: "Application submitted — Baseline Skills", type: "trainer" });
});

router.get("/trainer/login", (req, res) => {
  if (req.session.instructorId) return res.redirect("/trainer/dashboard");
  res.render("trainer-login", { title: "Trainer login — Baseline Skills", error: null });
});

router.post("/trainer/login", (req, res) => {
  const attemptStatus = trainerLoginAttempts.check(req);
  if (attemptStatus.blocked) {
    res.set("Retry-After", attemptStatus.retryAfterSeconds);
    return res.status(429).render("trainer-login", { title: "Trainer login — Baseline Skills", error: "Too many failed login attempts. Please wait 15 minutes and try again." });
  }
  const { email, password } = req.body;
  const instructor = store.findOne("instructors", (i) => i.email && i.email.toLowerCase() === String(email || "").toLowerCase());
  if (!instructor || !auth.verifyPassword(password, instructor.passwordHash)) {
    trainerLoginAttempts.recordFailure(req);
    return res.status(400).render("trainer-login", { title: "Trainer login — Baseline Skills", error: "Incorrect email or password." });
  }
  if (instructor.verificationStatus !== "approved") {
    trainerLoginAttempts.recordFailure(req);
    return res.status(403).render("trainer-login", { title: "Trainer login — Baseline Skills", error: `Your application is currently ${instructor.verificationStatus}. We'll email you once it's reviewed.` });
  }
  trainerLoginAttempts.recordSuccess(req);
  req.session.regenerate((err) => {
    if (err) return res.status(500).render("trainer-login", { title: "Trainer login — Baseline Skills", error: "Session error." });
    req.session.instructorId = instructor.id;
    res.redirect("/trainer/dashboard");
  });
});

router.get("/trainer/dashboard", auth.requireInstructor, (req, res) => {
  const instructor = store.findOne("instructors", (i) => i.id === req.session.instructorId);
  const courses = store.readAll("courses").filter((c) => c.trainerId === instructor.id);
  const referralCode = store.findOne("referral_codes", (r) => r.ownerType === "instructor" && r.ownerId === instructor.id);
  // Strictly limited to registrations for courses this instructor actually
  // teaches — deliberately NOT also matching on referredById, which would
  // pull in a sale this instructor personally referred but for a course a
  // different instructor teaches (permitted by Phase 7's "site-wide
  // referral code" simplification). Even though the view never displayed
  // course/learner identity for those cross-course earnings, the
  // underlying data pull still crossed into another trainer's course,
  // which "his own course and training session only" rules out — a
  // cross-course referral an instructor personally generated is still
  // correctly credited and paid out via the real payout system (Phase 7);
  // it just isn't reflected in this strictly own-course view.
  const registrations = store.readAll("registrations").filter((r) => courses.some((c) => c.id === r.courseId));
  const earnings = registrations
    .filter((r) => r.status === "confirmed" || r.status === "invoice_pending")
    .map((r) => commissions.calculateCommission(r))
    .filter((c) => c.recipientType === "instructor" && c.recipientId === instructor.id);
  const totalEarnedCents = earnings.reduce((sum, e) => sum + e.commissionCents, 0);
  const payouts = store.readAll("payouts").filter((p) => p.recipientType === "instructor" && p.recipientId === instructor.id).sort((a, b) => new Date(b.periodEnd) - new Date(a.periodEnd));
  res.render("trainer-dashboard", { title: "Trainer Dashboard — Baseline Skills", noindex: true, instructor, courses, referralCode, earnings, totalEarnedCents, payouts });
});

router.get("/trainer/logout", (req, res) => { req.session.destroy(() => res.redirect("/")); });

// ==================== Become an Affiliate ====================
router.get("/become-an-affiliate", (req, res) => {
  res.render("become-an-affiliate", { title: "Become an Affiliate — Baseline Skills", error: null });
});

router.post("/become-an-affiliate/apply", applicationRateLimiter, handleRoeUpload("become-an-affiliate"), (req, res) => {
  const { name, email, password, organization } = req.body;
  if (!name || !email || !password || !req.file) {
    return res.status(400).render("become-an-affiliate", { title: "Become an Affiliate — Baseline Skills", error: "Name, email, password, and the signed Rules of Engagement PDF are all required." });
  }
  if (password.length < onboardingCfg.PASSWORD_MIN_LENGTH) {
    return res.status(400).render("become-an-affiliate", { title: "Become an Affiliate — Baseline Skills", error: `Password must be at least ${onboardingCfg.PASSWORD_MIN_LENGTH} characters.` });
  }
  const existing = store.findOne("affiliates", (a) => a.email.toLowerCase() === email.toLowerCase());
  if (existing && existing.status !== "rejected") {
    return res.status(400).render("become-an-affiliate", { title: "Become an Affiliate — Baseline Skills", error: "An application or account with that email already exists." });
  }

  let affiliate;
  if (existing) {
    affiliate = store.update("affiliates", existing.id, {
      passwordHash: auth.hashPassword(password),
      name, organization: organization || "",
      status: "pending", signedRoePath: req.file.filename, rejectionReason: null,
    });
  } else {
    affiliate = store.insert("affiliates", {
      id: newId("affiliate"), email: email.toLowerCase(), passwordHash: auth.hashPassword(password),
      name, organization: organization || "", commissionTier: "standard",
      status: "pending", signedRoePath: req.file.filename, createdAt: new Date().toISOString(),
    });
  }
  store.insert("roe_acknowledgments", {
    id: newId("roeack"), recipientType: "affiliate", recipientId: affiliate.id,
    sentAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString(),
  });

  res.render("application-submitted", { title: "Application submitted — Baseline Skills", type: "affiliate" });
});

router.get("/affiliate/login", (req, res) => {
  if (req.session.affiliateId) return res.redirect("/affiliate/dashboard");
  res.render("affiliate-login", { title: "Affiliate login — Baseline Skills", error: null });
});

router.post("/affiliate/login", (req, res) => {
  const attemptStatus = affiliateLoginAttempts.check(req);
  if (attemptStatus.blocked) {
    res.set("Retry-After", attemptStatus.retryAfterSeconds);
    return res.status(429).render("affiliate-login", { title: "Affiliate login — Baseline Skills", error: "Too many failed login attempts. Please wait 15 minutes and try again." });
  }
  const { email, password } = req.body;
  const affiliate = store.findOne("affiliates", (a) => a.email.toLowerCase() === String(email || "").toLowerCase());
  if (!affiliate || !auth.verifyPassword(password, affiliate.passwordHash)) {
    affiliateLoginAttempts.recordFailure(req);
    return res.status(400).render("affiliate-login", { title: "Affiliate login — Baseline Skills", error: "Incorrect email or password." });
  }
  if (affiliate.status !== "approved") {
    affiliateLoginAttempts.recordFailure(req);
    return res.status(403).render("affiliate-login", { title: "Affiliate login — Baseline Skills", error: `Your application is currently ${affiliate.status}. We'll email you once it's reviewed.` });
  }
  affiliateLoginAttempts.recordSuccess(req);
  req.session.regenerate((err) => {
    if (err) return res.status(500).render("affiliate-login", { title: "Affiliate login — Baseline Skills", error: "Session error." });
    req.session.affiliateId = affiliate.id;
    res.redirect("/affiliate/dashboard");
  });
});

router.get("/affiliate/dashboard", auth.requireAffiliate, (req, res) => {
  const affiliate = store.findOne("affiliates", (a) => a.id === req.session.affiliateId);
  const referralCode = store.findOne("referral_codes", (r) => r.ownerType === "affiliate" && r.ownerId === affiliate.id);
  const registrations = store.readAll("registrations").filter((r) => r.referralType === "affiliate" && r.referredById === affiliate.id);
  // Computed for every referred registration, not just confirmed ones —
  // calculateCommission itself doesn't gate on status, so filtering the
  // earnings array separately from the registrations array it's displayed
  // alongside would have misaligned them by index. A not-yet-confirmed
  // registration still gets a real (zero-value-until-paid) entry here
  // rather than silently shifting every later row out of position.
  const earnings = registrations.map((r) => (r.status === "confirmed" || r.status === "invoice_pending") ? commissions.calculateCommission(r) : null);
  const totalEarnedCents = earnings.reduce((sum, e) => sum + (e ? e.commissionCents : 0), 0);
  const quarterlyRevenueCents = commissions.affiliateQuarterlyRevenueCents(affiliate.id, new Date().toISOString());
  const payouts = store.readAll("payouts").filter((p) => p.recipientType === "affiliate" && p.recipientId === affiliate.id).sort((a, b) => new Date(b.periodEnd) - new Date(a.periodEnd));
  res.render("affiliate-dashboard", { title: "Affiliate Dashboard — Baseline Skills", noindex: true, affiliate, referralCode, registrations, earnings, totalEarnedCents, quarterlyRevenueCents, payouts });
});

router.get("/affiliate/logout", (req, res) => { req.session.destroy(() => res.redirect("/")); });

module.exports = router;
