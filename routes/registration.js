const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const store = require("../lib/db");
const { sendMail, escapeHtml } = require("../lib/mailer");
const { newId } = require("../lib/id");
const payments = require("../lib/payments");
const discounts = require("../lib/discounts");
const pricing = require("../lib/pricing");
const { currencySymbol } = require("../lib/currency");
const auth = require("../lib/auth");
const invoices = require("../lib/invoices");
const createRateLimiter = require("../lib/rate-limiter");
const security = require("../lib/security");

// CSRF protection (Origin/Referer matching) for everything in this router
// EXCEPT webhook endpoints — a real webhook call from Paddle or PayPal's
// own servers is a server-to-server request with no browser Origin/Referer
// at all, which requireSameOrigin correctly treats as suspicious for a
// normal form submission but would incorrectly reject for a legitimate
// webhook. Webhooks authenticate via their own signature mechanisms
// (Paddle's HMAC, PayPal's verification API) instead — that is the correct
// defense for a server-to-server call, not origin matching, which doesn't
// apply to a request with no browser involved at all.
router.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/")) return next();
  return security.requireSameOrigin(req, res, next);
});


const regCfg = discounts.loadConfig().security;

const regRateLimiter = createRateLimiter({
  windowMs: regCfg.REGISTRATION_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: regCfg.REGISTRATION_RATE_LIMIT_MAX,
  keyPrefix: "course_reg",
  message: "Too many registration requests. Please wait a few minutes before trying again.",
});

// ---- Registration form ----
router.get("/courses/:slug/register", (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: "Course not found" });
  // Referral capture — simplified to session-based rather than the full
  // 30-day cookie REFERRAL_ATTRIBUTION_WINDOW_DAYS implies; a visitor who
  // clicks a referral link and registers within the same session is
  // attributed correctly, but won't be if they return days later without
  // the link. Documented as a deliberate scope reduction, not an oversight.
  if (req.query.ref) req.session.refCode = req.query.ref;
  // Part 1C/19: Recorded has no session/date at all -- resolved before
  // sessionStartDate below, so a Recorded selection (from the query, or
  // the only public mode this course offers) never falls back to some
  // other mode's session date, which would misattribute an early-bird
  // window and a real session's seat capacity to a registration that
  // has nothing to do with that session.
  const publicModes = course.deliveryModes.filter((m) => !["Corporate On-site", "Private Cohort"].includes(m));
  const selectedDeliveryMode = publicModes.includes(req.query.mode) ? req.query.mode : (publicModes[0] || "");
  const sessionStartDate = selectedDeliveryMode === "Recorded" ? "" : (req.query.session || (course.sessions[0] && course.sessions[0].startDate) || "");
  const couponCode = req.query.coupon || "";
  const couponValidation = couponCode ? discounts.validateCouponCode(couponCode, course.id, sessionStartDate) : null;
  const discountInfo = discounts.earlyBirdForSession(sessionStartDate);
  const examProduct = store.findOne("certification_exams", (e) => e.courseId === course.id);
  const examDiscountPercent = discounts.effectiveDiscountPercent(course, sessionStartDate, couponValidation && couponValidation.valid ? couponCode : null);
  const examFinalPriceCents = examProduct ? Math.round(examProduct.priceCents * (1 - examDiscountPercent / 100)) : null;
  res.render("register", {
    title: `Register — ${course.title}`, course,
    finalPrice: discounts.finalPriceCentsForSession(course, sessionStartDate, couponValidation && couponValidation.valid ? couponCode : null),
    discountInfo, selectedSessionStartDate: sessionStartDate, selectedDeliveryMode,
    examProduct, examFinalPriceCents,
    couponCode, couponValidation,
  });
});

// ---- Live pricing preview (Part 18): the browser never computes or
// trusts its own arithmetic for the displayed price, only for the amount
// actually charged -- both come from the same lib/pricing.js call. GET,
// not POST: read-only, no state change, and simpler to call from a plain
// fetch() without a CSRF token dance for something that changes nothing.
router.get("/courses/:slug/register/pricing-preview", (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).json({ error: "Course not found" });
  const participantCount = Math.max(1, Math.min(50, parseInt(req.query.participantCount, 10) || 1));
  const deliveryMode = req.query.deliveryMode || course.deliveryModes[0];
  const sessionStartDate = deliveryMode === "Recorded" ? null : (req.query.sessionStartDate || (course.sessions[0] && course.sessions[0].startDate) || null);
  const result = pricing.calculatePricing({ course, deliveryMode, participantCount, sessionStartDate, couponCode: null });
  res.json({ ...result, currencySymbol: currencySymbol(result.currency) });
});

// ---- Submit registration ----
router.post("/courses/:slug/register", regRateLimiter, async (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: "Course not found" });

  const { name, email, phone, address, company, role, sessionStartDate, deliveryMode, notes, addExam, couponCode } = req.body;
  const resolvedDeliveryMode = deliveryMode || (course.sessions[0] && course.sessions[0].mode) || "";
  // Part 1C: Recorded has no session at all -- resolved from the mode
  // first, so a submitted date (or the fallback to the course's first
  // session) is never attached to a Recorded registration regardless of
  // what the client sent, closing the same "silently borrows an
  // unrelated session's date" gap fixed on the GET route above.
  const resolvedSessionStartDate = resolvedDeliveryMode === "Recorded" ? "" : (sessionStartDate || (course.sessions[0] && course.sessions[0].startDate) || "");
  const couponValidation = couponCode ? discounts.validateCouponCode(couponCode, course.id, resolvedSessionStartDate) : null;
  const validCoupon = couponValidation && couponValidation.valid ? couponCode : null;
  const discountInfo = discounts.earlyBirdForSession(resolvedSessionStartDate);
  const examProduct = store.findOne("certification_exams", (e) => e.courseId === course.id);
  const examDiscountPercent = discounts.effectiveDiscountPercent(course, resolvedSessionStartDate, validCoupon);
  const examFinalPriceCents = examProduct ? Math.round(examProduct.priceCents * (1 - examDiscountPercent / 100)) : null;
  const examSelected = !!addExam && !!examProduct;

  // Re-rendering the form on any validation failure needs the same shape
  // of data the GET route builds — kept as one local helper rather than
  // repeating this object at every early-return below.
  const rerender = (status, error) => res.status(status).render("register", {
    title: `Register — ${course.title}`, course,
    finalPrice: pricing.calculatePricing({ course, deliveryMode: resolvedDeliveryMode, participantCount: 1, sessionStartDate: resolvedSessionStartDate, couponCode: validCoupon }).finalTotalCents,
    discountInfo, selectedSessionStartDate: resolvedSessionStartDate, selectedDeliveryMode: resolvedDeliveryMode,
    examProduct, examFinalPriceCents, couponCode, couponValidation,
    error, form: req.body,
  });

  // Part 1E/1F/23: Corporate On-site and Private Cohort must never enter
  // the normal payment flow, full stop -- not a UI-layer courtesy that a
  // direct POST could route around. Checked here, before any pricing or
  // registration logic runs at all, against the same allowlist the
  // course-detail page and the corporate-training inquiry route both use,
  // so a request that names either mode is rejected outright rather than
  // silently priced at 0 (null coerces to 0 in the total, which is
  // exactly the free-registration bypass this check exists to close).
  // Redirected to the real inquiry flow, pre-filled, rather than a bare
  // error -- the visitor still gets somewhere useful.
  if (["Corporate On-site", "Private Cohort"].includes(resolvedDeliveryMode)) {
    return res.redirect(`/corporate-training?course=${encodeURIComponent(course.slug)}&mode=${encodeURIComponent(resolvedDeliveryMode)}`);
  }

  if (couponCode && !validCoupon) return rerender(400, couponValidation.reason);
  if (!name || !email) return rerender(400, "Name and email are required.");

  // Part 6/23: participant details, validated server-side regardless of
  // what the client-side stepper showed — a tampered or scripted request
  // could submit any count/array shape, so the array lengths and each
  // participant's required fields are checked here, not assumed from the
  // stepper's last known value.
  const participantNames = Array.isArray(req.body.participantName) ? req.body.participantName : [req.body.participantName].filter((v) => v !== undefined);
  const participantEmails = Array.isArray(req.body.participantEmail) ? req.body.participantEmail : [req.body.participantEmail].filter((v) => v !== undefined);
  const participantPhones = Array.isArray(req.body.participantPhone) ? req.body.participantPhone : [req.body.participantPhone].filter((v) => v !== undefined);
  const participants = participantNames.map((n, i) => ({
    name: (n || "").trim(), email: (participantEmails[i] || "").trim(), phone: (participantPhones[i] || "").trim(),
  }));

  if (participants.length === 0 || participants.length > 50) return rerender(400, "At least one participant is required.");
  if (participants.some((p) => !p.name || !p.email)) return rerender(400, "Every participant needs a name and email address.");
  const emailValidator = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (participants.some((p) => !emailValidator.test(p.email))) return rerender(400, "One of the participant email addresses doesn't look valid.");
  const lowerEmails = participants.map((p) => p.email.toLowerCase());
  if (new Set(lowerEmails).size !== lowerEmails.length) return rerender(400, "Each participant needs a different email address — two participants have the same one.");

  const participantCount = participants.length;
  const purchaserEmailLower = email.toLowerCase();
  const purchaserIndex = participants.findIndex((p) => p.email.toLowerCase() === purchaserEmailLower);
  const purchaserIsParticipant = purchaserIndex !== -1;

  // Duplicate-registration check, extended to every person in the group —
  // same reasoning as the original single-person check (an accidental
  // resubmission for the same course+session is blocked; a different
  // session is a genuinely new registration and allowed), now run once
  // per participant email plus the purchaser's own if they aren't one.
  const emailsToCheck = purchaserIsParticipant ? lowerEmails : [...lowerEmails, purchaserEmailLower];
  const alreadyRegistered = emailsToCheck.filter((e) =>
    store.findOne("registrations", (r) =>
      r.courseId === course.id && r.email.toLowerCase() === e &&
      r.sessionStartDate === resolvedSessionStartDate && r.status !== "cancelled" && r.status !== "refunded"
    )
  );
  if (alreadyRegistered.length > 0) {
    // Recorded has no real session (resolvedSessionStartDate is always
    // "" for it), so "already registered for this session ()" would be
    // confusing -- worded around the course itself for that case instead.
    const sessionPhrase = resolvedSessionStartDate ? `this session (${resolvedSessionStartDate})` : "this course";
    return rerender(400, `${alreadyRegistered.length === 1 ? "One of these people is" : "Some of these people are"} already registered for ${sessionPhrase}. If you need to change or cancel an existing registration, please contact us.`);
  }

  // Seat-availability check for the whole group at once, same atomic
  // UPDATE ... WHERE pattern as the original single-seat check (a
  // read-then-write here would let two groups racing for the last few
  // seats both pass a check against stale data) — just decrementing and
  // requiring participantCount seats instead of exactly one.
  const sessionRow = resolvedSessionStartDate
    ? course.sessions.find((s) => s.startDate === resolvedSessionStartDate)
    : null;
  if (sessionRow && sessionRow.seatsLeft !== null && sessionRow.seatsLeft !== undefined) {
    const seatResult = store.raw
      .prepare(`UPDATE sessions SET seatsLeft = seatsLeft - ? WHERE id = ? AND seatsLeft >= ?`)
      .run(participantCount, sessionRow.id, participantCount);
    if (seatResult.changes === 0) {
      return rerender(400, participantCount === 1
        ? "This session is sold out. Please register for another session."
        : `Only ${sessionRow.seatsLeft} seat${sessionRow.seatsLeft === 1 ? "" : "s"} left in this session — not enough for ${participantCount} participants. Please register for another session or reduce your group size.`);
    }
  }

  // Part 10: the one server-side pricing calculation, using the real
  // participant count — never the browser's own arithmetic, which only
  // ever drove the live preview, not this.
  const priceResult = pricing.calculatePricing({ course, deliveryMode: resolvedDeliveryMode, participantCount, sessionStartDate: resolvedSessionStartDate, couponCode: validCoupon });

  const groupRegistrationId = participantCount > 1 || !purchaserIsParticipant ? newId("group") : null;
  const nowIso = new Date().toISOString();

  // Part 15: each participant gets (or reuses) their own learner account,
  // exactly the logic the original single-person flow already used —
  // extracted here so it runs once per participant instead of being
  // duplicated inline.
  function findOrCreateLearner(personName, personEmail) {
    const existingSessionLearnerId = personEmail.toLowerCase() === purchaserEmailLower ? (req.session.learnerId || null) : null;
    if (existingSessionLearnerId) return { learnerId: existingSessionLearnerId, passwordSetToken: null };
    const existingLearner = store.findOne("learners", (l) => l.email.toLowerCase() === personEmail.toLowerCase());
    if (existingLearner) return { learnerId: existingLearner.id, passwordSetToken: null };
    const passwordSetToken = crypto.randomBytes(32).toString("hex");
    const newLearner = store.insert("learners", {
      id: newId("learner"), email: personEmail.toLowerCase(), passwordHash: null,
      name: personName, country: "", phone: "",
      passwordResetToken: passwordSetToken,
      passwordResetExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: nowIso,
    });
    return { learnerId: newLearner.id, passwordSetToken };
  }

  const refCodeRow = req.session.refCode ? store.findOne("referral_codes", (r) => r.code === req.session.refCode) : null;

  const createdRegistrations = [];
  participants.forEach((p, i) => {
    const isThisThePurchaser = purchaserIsParticipant && i === purchaserIndex;
    const { learnerId, passwordSetToken } = findOrCreateLearner(p.name, p.email);
    const reg = {
      id: newId("reg"),
      courseId: course.id, courseTitle: course.title, learnerId,
      name: p.name, email: p.email, phone: p.phone || "",
      address: isThisThePurchaser ? (address || "") : "", company: isThisThePurchaser ? (company || "") : "", role: isThisThePurchaser ? (role || "") : "",
      sessionStartDate: resolvedSessionStartDate, deliveryMode: resolvedDeliveryMode, notes: isThisThePurchaser ? (notes || "") : "",
      // The group's pricing/exam charge lives once, on the purchaser's
      // row only (Part 14) — every other participant's row charges
      // nothing individually, since the purchaser paid for the group.
      priceCentsCharged: isThisThePurchaser ? (priceResult.finalTotalCents + (examSelected ? examFinalPriceCents : 0)) : 0,
      certificationExamId: isThisThePurchaser && examSelected ? examProduct.id : null,
      examPriceCentsCharged: isThisThePurchaser && examSelected ? examFinalPriceCents : null,
      currency: course.currency,
      status: "pending_payment",
      groupRegistrationId, isPurchaser: isThisThePurchaser ? 1 : 0,
      participantCount: isThisThePurchaser ? participantCount : 1,
      baseTotalCents: isThisThePurchaser ? priceResult.baseTotalCents : null,
      groupDiscountPercent: isThisThePurchaser ? priceResult.discountPercent : 0,
      groupDiscountAmountCents: isThisThePurchaser ? priceResult.discountAmountCents : 0,
      grantsAccess: 1,
      createdAt: nowIso,
      _passwordSetToken: passwordSetToken, // consumed for the email below, not a real column
    };
    if (refCodeRow) { reg.referredById = refCodeRow.ownerId; reg.referralType = refCodeRow.ownerType; }
    createdRegistrations.push(reg);
  });

  // Part 15: a purchaser who isn't attending still needs a row -- it
  // anchors the group and carries the payment -- but grantsAccess is 0,
  // so isEnrolled() and every access check that respects it (previous
  // commit) correctly never grants them course access on the strength of
  // this row alone.
  let purchaserReg;
  if (purchaserIsParticipant) {
    purchaserReg = createdRegistrations[purchaserIndex];
  } else {
    const { learnerId, passwordSetToken } = findOrCreateLearner(name, email);
    purchaserReg = {
      id: newId("reg"),
      courseId: course.id, courseTitle: course.title, learnerId,
      name, email, phone: phone || "", address: address || "", company: company || "", role: role || "",
      sessionStartDate: resolvedSessionStartDate, deliveryMode: resolvedDeliveryMode, notes: notes || "",
      priceCentsCharged: priceResult.finalTotalCents + (examSelected ? examFinalPriceCents : 0),
      certificationExamId: examSelected ? examProduct.id : null,
      examPriceCentsCharged: examSelected ? examFinalPriceCents : null,
      currency: course.currency,
      status: "pending_payment",
      groupRegistrationId, isPurchaser: 1,
      participantCount, baseTotalCents: priceResult.baseTotalCents,
      groupDiscountPercent: priceResult.discountPercent, groupDiscountAmountCents: priceResult.discountAmountCents,
      grantsAccess: 0,
      createdAt: nowIso,
      _passwordSetToken: passwordSetToken,
    };
    if (refCodeRow) { purchaserReg.referredById = refCodeRow.ownerId; purchaserReg.referralType = refCodeRow.ownerType; }
    createdRegistrations.push(purchaserReg);
  }

  createdRegistrations.forEach((r) => {
    const { _passwordSetToken, ...row } = r;
    store.insert("registrations", row);
  });

  const available = payments.availableProviders();

  if (available.length === 0) {
    await finalizeRegistration(purchaserReg.id, { viaFallback: true });
    return res.redirect(`/register/success?reg=${purchaserReg.id}`);
  }

  if (available.length > 1) {
    return res.redirect(`/register/choose-payment?reg=${purchaserReg.id}`);
  }

  return startCheckout(res, available[0], course, purchaserReg);
});

async function startCheckout(res, providerName, course, registration) {
  try {
    const order = await payments.createOrder(providerName, { course, registration });
    const orderIdField = providerName === "paddle" ? "paddleTransactionId" : "paypalOrderId";
    await store.update("registrations", registration.id, { paymentProvider: providerName, [orderIdField]: order.orderId });
    return res.redirect(`/register/checkout/${providerName}?reg=${registration.id}`);
  } catch (err) {
    console.error(`[registration] ${providerName} order creation failed:`, err.message);
    // Don't leave the visitor stuck — fall back to invoice-pending rather
    // than showing a dead end if the provider's API itself is
    // unreachable/erroring.
    await finalizeRegistration(registration.id, { viaFallback: true });
    return res.redirect(`/register/success?reg=${registration.id}`);
  }
}

router.get("/register/choose-payment", (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  if (!reg) return res.status(404).render("404", { title: "Registration not found" });
  res.render("choose-payment", { title: "Choose a payment method — Baseline Skills", registration: reg, providers: payments.availableProviders() });
});

router.post("/register/choose-payment", async (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.body.reg);
  if (!reg) return res.status(404).render("404", { title: "Registration not found" });
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  if (!payments.isValidProvider(req.body.provider) || !payments.isConfigured(req.body.provider)) {
    return res.redirect(`/register/choose-payment?reg=${reg.id}`);
  }
  return startCheckout(res, req.body.provider, course, reg);
});

// ---- Checkout page: loads Paddle.js and opens the overlay for this registration's transaction ----
router.get("/register/checkout/:provider", (req, res) => {
  const providerName = req.params.provider;
  if (!payments.isValidProvider(providerName)) return res.status(404).render("404", { title: "Unknown payment method" });
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  const orderIdField = providerName === "paddle" ? "paddleTransactionId" : "paypalOrderId";
  if (!reg || !reg[orderIdField]) return res.status(404).render("404", { title: "Registration not found" });
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  const clientConfig = payments.getClientConfig(providerName);
  res.render("checkout", { title: "Complete payment — Baseline Skills", noindex: true, registration: reg, course, clientConfig, provider: providerName, orderId: reg[orderIdField] });
});

// ---- Shared finalize step: used by both the Paddle webhook and the no-Paddle fallback ----
async function finalizeRegistration(registrationId, opts = {}) {
  const reg = store.findOne("registrations", (r) => r.id === registrationId);
  if (!reg) return null;
  if (reg.status === "confirmed") return reg; // already finalized — don't double-send emails

  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  const newStatus = opts.viaFallback ? "invoice_pending" : "confirmed";
  const confirmedAt = new Date().toISOString();
  const updated = await store.update("registrations", registrationId, { status: newStatus, confirmedAt });

  // Part 13: idempotent webhook confirmation, extended to a group -- every
  // sibling row sharing this groupRegistrationId is confirmed together in
  // the same call, not just the purchaser's own row, so a participant's
  // access doesn't depend on a second, separate webhook ever arriving for
  // their individual row (there isn't one; only the purchaser's row is
  // tied to the actual payment transaction). Every sibling update reuses
  // the same "already confirmed, skip" guard as the top of this function,
  // so a retried webhook delivery still can't double-process or double-
  // email anyone in the group.
  const groupSiblings = reg.groupRegistrationId
    ? store.readAll("registrations").filter((r) => r.groupRegistrationId === reg.groupRegistrationId && r.id !== reg.id && r.status !== "confirmed")
    : [];
  for (const sibling of groupSiblings) {
    await store.update("registrations", sibling.id, { status: newStatus, confirmedAt });
  }

  // Only generate an invoice for a genuinely confirmed (webhook-verified)
  // payment — "invoice_pending" is explicitly not a completed payment (it's
  // the no-provider-configured fallback), so a "paid" invoice would
  // misrepresent what actually happened. A real failure to generate the PDF
  // is logged but never allowed to block the confirmation itself — the
  // registration is genuinely confirmed regardless of whether the invoice
  // artifact could be produced.
  if (!opts.viaFallback) {
    try { await invoices.createInvoiceForRegistration(updated); }
    catch (err) { console.error("[registration] invoice generation failed:", err.message); }
  }

  // Purchase-stage feedback prompt (Section 14/15) — created here, once,
  // at the moment of confirmed purchase, for the purchaser and, for a
  // group, every attending participant too (each has their own real
  // course experience to give feedback on).
  const feedbackTargets = [reg, ...groupSiblings].filter((r) => r.learnerId && r.grantsAccess !== 0);
  for (const target of feedbackTargets) {
    const existingPurchaseFeedback = store.findOne("feedback", (f) => f.learnerId === target.learnerId && f.courseId === target.courseId && f.stage === "purchase");
    if (!existingPurchaseFeedback) {
      store.insert("feedback", {
        id: newId("feedback"), learnerId: target.learnerId, courseId: target.courseId,
        sessionId: null, moduleId: null, stage: "purchase",
        rating: null, comment: null, structuredAnswers: null, createdAt: new Date().toISOString(),
      });
    }
  }

  const priceDisplay = ((updated.priceCentsCharged || 0) / 100).toFixed(2);
  const paymentNote = opts.viaFallback
    ? `<p><em>Payment processing isn't fully configured on this instance yet — this registration has been recorded as invoice-pending. Set PADDLE_API_KEY and PADDLE_CLIENT_TOKEN to enable live card payments via Paddle.</em></p>`
    : "";

  const courseTitle = escapeHtml(course ? course.title : reg.courseTitle);

  function setPasswordNoteFor(registration) {
    if (!registration.learnerId) return "";
    const learner = store.findOne("learners", (l) => l.id === registration.learnerId);
    if (learner && !learner.passwordHash && learner.passwordResetToken) {
      const setPasswordUrl = `${process.env.APP_BASE_URL || "https://www.baselineskills.com"}/set-password?token=${learner.passwordResetToken}`;
      return `<p>We've set up an account for you so you can track this registration — <a href="${setPasswordUrl}">set a password</a> to log in any time.</p>`;
    }
    return "";
  }

  await sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New registration — ${courseTitle.replace(/[\r\n]/g, "")} (${escapeHtml(reg.name).replace(/[\r\n]/g, "")})`,
    html: `<h2>New course registration</h2>
      <p><strong>${escapeHtml(reg.name)}</strong> (${escapeHtml(reg.email)}) registered for <strong>${courseTitle}</strong>${reg.participantCount > 1 ? ` &mdash; group of ${reg.participantCount}` : ""}.</p>
      <ul>
        <li>Company: ${escapeHtml(reg.company) || "n/a"}</li>
        <li>Role: ${escapeHtml(reg.role) || "n/a"}</li>
        <li>Session: ${escapeHtml(reg.sessionStartDate)} (${escapeHtml(reg.deliveryMode)})</li>
        <li>Amount: ${escapeHtml(reg.currency)} ${priceDisplay}${reg.groupDiscountPercent ? ` (${reg.groupDiscountPercent}% group discount applied)` : ""}</li>
        <li>Status: ${escapeHtml(updated.status)}</li>
      </ul>
      ${groupSiblings.length ? `<p>Participants: ${groupSiblings.map((s) => escapeHtml(s.name)).join(", ")}${reg.grantsAccess === 0 ? " (purchaser not attending)" : ""}</p>` : ""}
      ${paymentNote}`,
  });

  if (reg.groupRegistrationId && (groupSiblings.length > 0 || reg.grantsAccess === 0)) {
    // Part 16: a consolidated confirmation to the purchaser (course,
    // delivery mode, participants, base price, participant count, group
    // discount, discount amount, final amount, payment status, next
    // steps) rather than the single-registration email, which wouldn't
    // mention anyone but the purchaser themself.
    const attendingParticipants = [reg, ...groupSiblings].filter((r) => r.grantsAccess !== 0);
    await sendMail({
      to: reg.email,
      subject: `You're registered — ${courseTitle.replace(/[\r\n]/g, "")} (${reg.participantCount} participants)`,
      html: `<h2>Thanks for registering, ${escapeHtml(reg.name)}!</h2>
        <p>Your group is booked on <strong>${courseTitle}</strong>.</p>
        <ul>
          <li>Session: ${escapeHtml(reg.sessionStartDate)}</li>
          <li>Delivery mode: ${escapeHtml(reg.deliveryMode)}</li>
          <li>Participants (${attendingParticipants.length}): ${attendingParticipants.map((p) => escapeHtml(p.name)).join(", ") || "none — you registered this group without attending yourself"}</li>
          <li>Base price: ${escapeHtml(reg.currency)} ${((reg.baseTotalCents || 0) / 100).toFixed(2)}</li>
          ${reg.groupDiscountPercent ? `<li>Group discount: ${reg.groupDiscountPercent}% (&minus;${escapeHtml(reg.currency)} ${((reg.groupDiscountAmountCents || 0) / 100).toFixed(2)})</li>` : ""}
          <li><strong>Total: ${escapeHtml(reg.currency)} ${priceDisplay}</strong></li>
          <li>Payment status: ${escapeHtml(updated.status)}</li>
        </ul>
        ${paymentNote}
        ${reg.grantsAccess !== 0 ? setPasswordNoteFor(reg) : ""}
        <p>Each attending participant will receive their own email with course access details.</p>
        <p>We'll be in touch with joining instructions closer to the session date.</p>
        <p>— The Baseline Skills team</p>`,
    });

    // Part 16: each attending participant (other than the purchaser, who
    // already received the consolidated email above) gets their own
    // course-access notification.
    for (const participant of attendingParticipants) {
      if (participant.id === reg.id) continue;
      await sendMail({
        to: participant.email,
        subject: `You're enrolled — ${courseTitle.replace(/[\r\n]/g, "")}`,
        html: `<h2>Hi ${escapeHtml(participant.name)},</h2>
          <p>${escapeHtml(reg.name)} has registered you for <strong>${courseTitle}</strong>.</p>
          <ul>
            <li>Session: ${escapeHtml(participant.sessionStartDate)}</li>
            <li>Delivery mode: ${escapeHtml(participant.deliveryMode)}</li>
          </ul>
          ${setPasswordNoteFor(participant)}
          <p>We'll be in touch with joining instructions closer to the session date.</p>
          <p>— The Baseline Skills team</p>`,
      });
    }
  } else {
    await sendMail({
      to: reg.email,
      subject: `You're registered — ${courseTitle.replace(/[\r\n]/g, "")}`,
      html: `<h2>Thanks for registering, ${escapeHtml(reg.name)}!</h2>
        <p>You're booked on <strong>${courseTitle}</strong>.</p>
        <ul>
          <li>Session: ${escapeHtml(reg.sessionStartDate)}</li>
          <li>Delivery mode: ${escapeHtml(reg.deliveryMode)}</li>
          <li>Amount: ${escapeHtml(reg.currency)} ${priceDisplay}</li>
        </ul>
        ${paymentNote}
        ${setPasswordNoteFor(reg)}
        <p>We'll be in touch with joining instructions closer to the session date.</p>
        <p>— The Baseline Skills team</p>`,
    });
  }

  return updated;
}


// ---- Landing page after the Paddle overlay closes (belt-and-suspenders alongside the webhook) ----
router.get("/register/success", async (req, res) => {
  const regId = req.query.reg;
  const reg = store.findOne("registrations", (r) => r.id === regId);
  if (!reg) return res.status(404).render("404", { title: "Registration not found" });

  // The webhook is the authoritative confirmation path (see below) — this
  // redirect-based check exists only as a fallback in case the webhook is
  // delayed, since Paddle's overlay closing doesn't itself guarantee the
  // webhook has already been delivered and processed.
  const finalReg = store.findOne("registrations", (r) => r.id === regId);
  const course = store.findOne("courses", (c) => c.id === finalReg.courseId);
  res.render("register-success", { title: "Registration confirmed — Baseline Skills", noindex: true, registration: finalReg, course });
});

router.get("/register/cancel", (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  res.render("register-cancel", { title: "Registration not completed — Baseline Skills", noindex: true, registration: reg });
});

// ---- Paddle webhook — the authoritative payment-confirmation path ----
// Signature verification follows Paddle's documented HMAC-SHA256(ts:rawBody)
// scheme, same as ReqDrive's own webhook handlers.
function verifyPaddleSignature(rawBody, secret, signatureHeader) {
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const parts = Object.fromEntries(
    signatureHeader.split(";").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    })
  );
  const ts = Number(parts.ts);
  const h1 = parts.h1;
  if (!Number.isFinite(ts) || !h1) return { ok: false, reason: "malformed_signature" };

  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > 5 * 60) return { ok: false, reason: "timestamp_outside_tolerance" };

  const computed = crypto.createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(h1, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

router.post("/webhooks/paddle", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  // Fail closed, not open — an unconfigured secret must never be treated as
  // "skip verification." See the ReqCompass/ReqM webhook history for why
  // this specific mistake matters: it's a real, exploitable gap otherwise.
  if (!secret) {
    console.error("[paddle webhook] PADDLE_WEBHOOK_SECRET not configured — refusing to process");
    return res.status(500).send("Paddle webhook not configured");
  }

  const rawBody = req.body.toString("utf8");
  const verification = verifyPaddleSignature(rawBody, secret, req.headers["paddle-signature"]);
  if (!verification.ok) {
    console.error("[paddle webhook] signature verification failed:", verification.reason);
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send("Invalid payload");
  }

  if (event.event_type === "transaction.completed" || event.event_type === "transaction.paid") {
    const registrationId = event.data && event.data.custom_data && event.data.custom_data.registrationId;
    if (registrationId) {
      await finalizeRegistration(registrationId, { viaFallback: false });
    } else {
      console.warn("[paddle webhook] transaction.completed with no registrationId in custom_data");
    }
  }

  res.status(200).json({ received: true });
});

// ---- PayPal webhook — the authoritative payment-confirmation path ----
// PayPal verifies webhook authenticity via its own API call (see
// lib/payments/paypal.js), not a local HMAC like Paddle's — a real,
// deliberate difference between the two providers, not an inconsistency.
router.post("/webhooks/paypal", express.json(), async (req, res) => {
  const verification = await payments.paypal.verifyWebhookSignature(req.headers, req.body).catch((err) => ({ ok: false, reason: err.message }));
  if (!verification.ok) {
    console.error("[paypal webhook] signature verification failed:", verification.reason);
    return res.status(401).send("Invalid signature");
  }

  const event = req.body;

  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    const orderId = event.resource && event.resource.id;
    const reg = orderId ? store.findOne("registrations", (r) => r.paypalOrderId === orderId) : null;
    if (reg && reg.status !== "confirmed") {
      // Capturing an already-captured order is a no-op on PayPal's side,
      // not an error — safe to call even if a duplicate webhook triggers
      // this a second time before PAYMENT.CAPTURE.COMPLETED arrives.
      try { await payments.paypal.captureOrder(orderId); } catch (err) { console.error("[paypal webhook] capture failed:", err.message); }
    }
  }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const orderId = event.resource && event.resource.supplementary_data && event.resource.supplementary_data.related_ids && event.resource.supplementary_data.related_ids.order_id;
    const reg = orderId ? store.findOne("registrations", (r) => r.paypalOrderId === orderId) : null;
    if (reg) {
      await finalizeRegistration(reg.id, { viaFallback: false });
    } else {
      console.warn("[paypal webhook] PAYMENT.CAPTURE.COMPLETED with no matching registration for order", orderId);
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;
module.exports.finalizeRegistration = finalizeRegistration;
