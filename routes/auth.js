const express = require("express");
const router = express.Router();
const store = require("../lib/db");
const auth = require("../lib/auth");
const security = require("../lib/security");
const invoicesLib = require("../lib/invoices");
const fs = require("fs");
const path = require("path");
const { newId } = require("../lib/id");
const createRateLimiter = require("../lib/rate-limiter");
const discounts = require("../lib/discounts"); // also the home of the generic loadConfig() used for security parameters below

const cfg = discounts.loadConfig().security;

router.use((req, res, next) => { res.locals.passwordMinLength = cfg.PASSWORD_MIN_LENGTH; next(); });

const authRateLimiter = createRateLimiter({
  windowMs: cfg.SIGNUP_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: cfg.SIGNUP_RATE_LIMIT_MAX,
  keyPrefix: "learner_auth",
  message: `Too many attempts. Please wait ${cfg.SIGNUP_RATE_LIMIT_WINDOW_MINUTES} minutes.`,
});

router.get("/signup", (req, res) => {
  if (req.session.learnerId) return res.redirect("/account");
  res.render("signup", { title: "Create your account — Baseline Skills", error: null });
});

router.post("/signup", authRateLimiter, (req, res) => {
  const { name, email, password, country, phone } = req.body;
  if (!name || !email || !password) {
    return res.status(400).render("signup", { title: "Create your account — Baseline Skills", error: "Name, email, and password are required." });
  }
  if (password.length < cfg.PASSWORD_MIN_LENGTH) {
    return res.status(400).render("signup", { title: "Create your account — Baseline Skills", error: `Password must be at least ${cfg.PASSWORD_MIN_LENGTH} characters.` });
  }
  const existing = store.findOne("learners", l => l.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(400).render("signup", { title: "Create your account — Baseline Skills", error: "An account with that email already exists — try logging in instead." });
  }

  const learner = store.insert("learners", {
    id: newId("learner"),
    email: email.toLowerCase(),
    passwordHash: auth.hashPassword(password),
    name, country: country || "", phone: phone || "",
    createdAt: new Date().toISOString(),
  });

  req.session.regenerate((err) => {
    if (err) return res.status(500).render("signup", { title: "Create your account — Baseline Skills", error: "Session error — please try again." });
    req.session.learnerId = learner.id;
    res.redirect(req.query.next || "/account");
  });
});

router.get("/login", (req, res) => {
  if (req.session.learnerId) return res.redirect("/account");
  res.render("login", { title: "Log in — Baseline Skills", error: null, next: req.query.next || "" });
});

const loginAttempts = security.createLoginAttemptTracker({
  windowMs: cfg.LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000,
  maxAttempts: cfg.LOGIN_MAX_ATTEMPTS,
});

router.use(security.requireSameOrigin);

router.post("/login", (req, res) => {
  const attemptStatus = loginAttempts.check(req);
  if (attemptStatus.blocked) {
    res.set("Retry-After", attemptStatus.retryAfterSeconds);
    return res.status(429).render("login", { title: "Log in — Baseline Skills", error: "Too many failed login attempts. Please wait 15 minutes and try again.", next: req.body.next || "" });
  }

  const { email, password } = req.body;
  const learner = store.findOne("learners", l => l.email.toLowerCase() === String(email || "").toLowerCase());

  if (!learner || !auth.verifyPassword(password, learner.passwordHash)) {
    loginAttempts.recordFailure(req);
    return res.status(400).render("login", { title: "Log in — Baseline Skills", error: "Incorrect email or password.", next: req.body.next || "" });
  }

  loginAttempts.recordSuccess(req);
  req.session.regenerate((err) => {
    if (err) return res.status(500).render("login", { title: "Log in — Baseline Skills", error: "Session error — please try again.", next: "" });
    req.session.learnerId = learner.id;
    res.redirect(req.body.next || "/account");
  });
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// A minimal, real "my account" page — just enough to prove the session and
// authorization actually work end-to-end. The full learner dashboard
// (courses in progress, certificates, wishlist) is out of scope for this
// phase; those features don't exist yet themselves (later phases).
router.get("/account", auth.requireLearner, (req, res) => {
  const learner = store.findOne("learners", l => l.id === req.session.learnerId);
  if (!learner) { req.session.destroy(() => {}); return res.redirect("/login"); }
  // Match by learnerId first (the correct relationship, now that registrations
  // set it for logged-in learners) — but keep the email fallback too, so
  // registrations made anonymously with this same email (before this fix, or
  // by a visitor who registered before creating an account) still show up
  // rather than silently disappearing from the account they clearly belong to.
  const registrations = store.readAll("registrations").filter(r =>
    r.learnerId === learner.id || r.email.toLowerCase() === learner.email.toLowerCase()
  );
  const invoicesByRegistration = {};
  store.readAll("invoices").forEach(inv => { if (inv.registrationId) invoicesByRegistration[inv.registrationId] = inv; });
  const certificates = store.readAll("certificates").filter(c => c.learnerId === learner.id);
  const coursesById = {};
  store.readAll("courses").forEach(c => { coursesById[c.id] = c; });
  const pendingFeedback = store.readAll("feedback").filter(f => f.learnerId === learner.id && f.rating === null);
  res.render("account", { title: "My Account — Baseline Skills", noindex: true, learner, registrations, invoicesByRegistration, certificates, coursesById, pendingFeedback, success: req.query.success });
});

// Submits (fills in) a pending feedback prompt created at purchase or
// course-completion time — owner only.
router.post("/account/feedback/:id", auth.requireLearner, (req, res) => {
  const feedback = store.findOne("feedback", (f) => f.id === req.params.id);
  if (!feedback || feedback.learnerId !== req.session.learnerId) return res.status(403).send("You don't have access to this feedback prompt.");
  const rating = Number(req.body.rating);
  if (!rating || rating < 1 || rating > 5) return res.status(400).send("Rating must be between 1 and 5.");
  store.update("feedback", feedback.id, { rating, comment: req.body.comment || "" });
  res.redirect("/account?success=Thanks+for+your+feedback");
});

// Certificate download — owner only, same ownership principle as invoice download.
router.get("/account/certificates/:id/download", auth.requireLearner, (req, res) => {
  const certificate = store.findOne("certificates", (c) => c.id === req.params.id);
  if (!certificate || certificate.learnerId !== req.session.learnerId) return res.status(403).send("You don't have access to this certificate.");
  const certificatesLib = require("../lib/certificates");
  const filePath = path.join(certificatesLib.CERTIFICATE_DIR, certificate.certificateUrl);
  if (!fs.existsSync(filePath)) return res.status(404).render("404", { title: "Certificate file not found" });
  res.download(filePath, `${certificate.certificateNumber}.pdf`);
});

// Invoice download — only the learner who owns the underlying registration
// (by learnerId or matching email, same dual-match as the account page
// itself) may download it, checked server-side, not just hidden from the
// UI for anyone else.
router.get("/account/invoices/:id/download", auth.requireLearner, (req, res) => {
  const invoice = store.findOne("invoices", (i) => i.id === req.params.id);
  if (!invoice || !invoice.registrationId) return res.status(404).render("404", { title: "Invoice not found" });
  const registration = store.findOne("registrations", (r) => r.id === invoice.registrationId);
  const learner = store.findOne("learners", (l) => l.id === req.session.learnerId);
  const owns = registration && (registration.learnerId === learner.id || registration.email.toLowerCase() === learner.email.toLowerCase());
  if (!owns) return res.status(403).send("You don't have access to this invoice.");

  const filePath = path.join(invoicesLib.INVOICE_DIR, invoice.pdfUrl);
  if (!fs.existsSync(filePath)) return res.status(404).render("404", { title: "Invoice file not found" });
  res.download(filePath, `${invoice.invoiceNumber}.pdf`);
});

// ---- Set password (for accounts auto-created during anonymous registration) ----
router.get("/set-password", (req, res) => {
  const learner = store.findOne("learners", (l) => l.passwordResetToken === req.query.token);
  if (!learner || new Date(learner.passwordResetExpires) < new Date()) {
    return res.status(400).render("set-password", { title: "Set your password — Baseline Skills", error: "This link is invalid or has expired. Please contact us for a new one.", token: null });
  }
  res.render("set-password", { title: "Set your password — Baseline Skills", error: null, token: req.query.token });
});

router.post("/set-password", authRateLimiter, (req, res) => {
  const { token, password } = req.body;
  const learner = store.findOne("learners", (l) => l.passwordResetToken === token);
  if (!learner || new Date(learner.passwordResetExpires) < new Date()) {
    return res.status(400).render("set-password", { title: "Set your password — Baseline Skills", error: "This link is invalid or has expired. Please contact us for a new one.", token: null });
  }
  if (!password || password.length < cfg.PASSWORD_MIN_LENGTH) {
    return res.status(400).render("set-password", { title: "Set your password — Baseline Skills", error: `Password must be at least ${cfg.PASSWORD_MIN_LENGTH} characters.`, token });
  }
  store.update("learners", learner.id, {
    passwordHash: auth.hashPassword(password),
    passwordResetToken: null, passwordResetExpires: null,
  });
  req.session.regenerate((err) => {
    if (err) return res.status(500).render("set-password", { title: "Set your password — Baseline Skills", error: "Session error — please try again.", token: null });
    req.session.learnerId = learner.id;
    res.redirect("/account?success=Password+set");
  });
});

module.exports = router;
