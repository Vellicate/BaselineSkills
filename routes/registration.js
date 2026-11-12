const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const store = require("../lib/db");
const { sendMail, escapeHtml } = require("../lib/mailer");
const { newId } = require("../lib/id");
const payments = require("../lib/payments");
const discounts = require("../lib/discounts");
const pricing = require("../lib/pricing");
const vat = require("../lib/vat");
const { COUNTRIES } = require("../lib/countries");
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
  if (!course) return res.status(404).render("404", { title: res.locals.t('title_course_not_found') });
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
  const examSelected = req.query.addExam === "true" && !!examProduct;
  const basePriceCents = discounts.finalPriceCentsForSession(course, sessionStartDate, couponValidation && couponValidation.valid ? couponCode : null);
  res.render("register", {
    title: res.locals.t('title_register_course', course.title), course,
    finalPrice: basePriceCents + (examSelected ? examFinalPriceCents : 0),
    discountInfo, selectedSessionStartDate: sessionStartDate, selectedDeliveryMode,
    examProduct, examFinalPriceCents, examSelected,
    couponCode, couponValidation, countries: COUNTRIES,
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

  // Coupon support (added after this preview shipped without it — the
  // live preview never reflected a coupon at all, only the final,
  // full-page submission did, which is why applying one here previously
  // showed no visible price change until after clicking Continue).
  const couponCode = (req.query.couponCode || "").trim();
  const couponValidation = couponCode ? discounts.validateCouponCode(couponCode, course.id, sessionStartDate) : null;
  const validCoupon = couponValidation && couponValidation.valid ? couponCode : null;

  const result = pricing.calculatePricing({ course, deliveryMode, participantCount, sessionStartDate, couponCode: validCoupon });

  // Part 1: the exam add-on and VAT are both real, separate line items in
  // the breakdown the registration page shows -- the preview mirrors the
  // exact same calculation the real submission uses (below), so what the
  // visitor sees before submitting is never a different number from what
  // they're actually charged.
  const examProduct = store.findOne("certification_exams", (e) => e.courseId === course.id);
  const examSelected = req.query.addExam === "true" && !!examProduct;
  const examDiscountPercent = discounts.effectiveDiscountPercent(course, sessionStartDate, validCoupon);
  const examPriceCents = examSelected ? Math.round(examProduct.priceCents * (1 - examDiscountPercent / 100)) : 0;

  const taxableAmountCents = (result.finalTotalCents || 0) + examPriceCents;
  const { rate: vatRatePercent, vatAmountCents } = vat.calculateVat(taxableAmountCents, req.query.country || null);
  const grandTotalCents = taxableAmountCents + vatAmountCents;

  res.json({
    ...result, examPriceCents, vatRatePercent, vatAmountCents, grandTotalCents, currencySymbol: currencySymbol(result.currency),
    couponValid: couponCode ? !!(couponValidation && couponValidation.valid) : null,
    couponReason: couponValidation && !couponValidation.valid ? res.locals.t("coupon_reason_" + couponValidation.reasonKey) : null,
  });
});

// ---- Submit registration ----
router.post("/courses/:slug/register", regRateLimiter, async (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: res.locals.t('title_course_not_found') });

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
  const rerender = (status, error, extra = {}) => res.status(status).render("register", {
    title: res.locals.t('title_register_course', course.title), course,
    finalPrice: pricing.calculatePricing({ course, deliveryMode: resolvedDeliveryMode, participantCount: 1, sessionStartDate: resolvedSessionStartDate, couponCode: validCoupon }).finalTotalCents,
    discountInfo, selectedSessionStartDate: resolvedSessionStartDate, selectedDeliveryMode: resolvedDeliveryMode,
    examProduct, examFinalPriceCents, couponCode, couponValidation, countries: COUNTRIES,
    error, form: req.body, resumeUrl: null, duplicateEmails: [],
    ...extra,
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

  // An invalid coupon deliberately does NOT block registration -- it's
  // already been reduced to validCoupon (null) above, so every pricing
  // calculation below simply proceeds at full price without it, the same
  // way a blank coupon field always has. Blocking the whole registration
  // over a stale/mistyped code (previously done here) meant a customer
  // could get stuck with no way forward except realizing, unprompted,
  // that they needed to go delete text from a field the form never told
  // them was blocking anything -- found after real registrations were
  // getting stuck exactly that way.
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

  // Sweep abandoned pending_payment registrations before checking for
  // duplicates — see sweepAbandonedPendingRegistrations for why this can't
  // just be a query-time exclusion: it also releases the seat an abandoned
  // checkout was still holding.
  sweepAbandonedPendingRegistrations();

  // Duplicate-registration check, extended to every person in the group —
  // same reasoning as the original single-person check (an accidental
  // resubmission for the same course+session is blocked; a different
  // session is a genuinely new registration and allowed), now run once
  // per participant email plus the purchaser's own if they aren't one.
  //
  // The single-person case gets a more specific, more useful message: if
  // the registration blocking them is their own and still pending_payment,
  // they're offered a direct link to retry payment on it, rather than a
  // flat "contact us" — the actual self-service answer to "I'm not sure my
  // earlier payment went through", added because a solo registrant doesn't
  // need the group case's hedging below (which registration would a link
  // even point to, out of a whole group?), so there's no reason to make
  // them go through support just to retry their own payment.
  if (participants.length === 1 && purchaserIsParticipant) {
    const existing = store.findOne("registrations", (r) =>
      r.courseId === course.id && r.email.toLowerCase() === purchaserEmailLower &&
      r.sessionStartDate === resolvedSessionStartDate && r.status !== "cancelled" && r.status !== "refunded"
    );
    if (existing) {
      const sessionPhrase = resolvedSessionStartDate ? `this session (${resolvedSessionStartDate})` : "this course";
      if (existing.status === "pending_payment") {
        return rerender(400,
          `You already have a registration for ${sessionPhrase} that hasn't been paid yet. If your earlier payment didn't go through, you can retry it directly below instead of registering again.`,
          { resumeUrl: `/register/resume/${existing.id}` }
        );
      }
      return rerender(400, `You're already registered for ${sessionPhrase}. If you need to change or cancel your registration, please contact us.`);
    }
  } else {
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
      return rerender(400,
        `${alreadyRegistered.length === 1 ? "One of these people is" : "Some of these people are"} already registered for ${sessionPhrase} — highlighted below. If you need to change or cancel an existing registration, please contact us.`,
        { duplicateEmails: alreadyRegistered }
      );
    }
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

  // VAT: computed on the actual taxable amount (the discounted training
  // total plus the exam fee if selected), from the purchaser's own
  // billing country -- never trusted from the client as a rate or amount,
  // only the country code itself is client-supplied, and even that is
  // just a lookup key into the admin-managed vat_rates table, not a
  // number the client could inflate or zero out directly.
  const purchaserCountry = (req.body.country || "").trim().toUpperCase();
  const taxableAmountCents = priceResult.finalTotalCents + (examSelected ? examFinalPriceCents : 0);
  const { rate: vatRatePercent, vatAmountCents } = vat.calculateVat(taxableAmountCents, purchaserCountry);

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
      // VAT is included in the actual amount charged -- Paddle/PayPal
      // both charge whatever priceCentsCharged says, so it must already
      // be VAT-inclusive, not a separate amount the payment provider
      // would need to add itself.
      priceCentsCharged: isThisThePurchaser ? (priceResult.finalTotalCents + (examSelected ? examFinalPriceCents : 0) + vatAmountCents) : 0,
      certificationExamId: isThisThePurchaser && examSelected ? examProduct.id : null,
      examPriceCentsCharged: isThisThePurchaser && examSelected ? examFinalPriceCents : null,
      vatAmountCents: isThisThePurchaser ? vatAmountCents : 0, vatCountry: isThisThePurchaser ? (purchaserCountry || null) : null,
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
      priceCentsCharged: priceResult.finalTotalCents + (examSelected ? examFinalPriceCents : 0) + vatAmountCents,
      certificationExamId: examSelected ? examProduct.id : null,
      examPriceCentsCharged: examSelected ? examFinalPriceCents : null,
      vatAmountCents, vatCountry: purchaserCountry || null,
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

  const available = payments.availableProvidersForCountry(purchaserCountry);

  if (available.length === 0) {
    await finalizeRegistration(purchaserReg.id, { viaFallback: true });
    return res.redirect(`/register/success?reg=${purchaserReg.id}`);
  }

  // A real payment step is about to happen (either straight to checkout,
  // or a choice of provider first) — send a durable "complete your
  // registration" email right now, before any of that, so the buyer has a
  // way back to payment even if they close the tab before ever reaching
  // PayPal/Paddle, or close it partway through without approving.
  // Previously nothing was emailed until/unless payment actually
  // completed, so abandoning at any point before that left no record at
  // all for the buyer to return to — found during testing when a
  // registration stuck at pending_payment turned out to have no email,
  // no page, and no link anywhere that could get back to it.
  const resumeUrl = `${process.env.APP_BASE_URL || "https://www.baselineskills.com"}/register/resume/${purchaserReg.id}`;
  await sendMail({
    to: purchaserReg.email,
    subject: `Complete your registration — ${course.title.replace(/[\r\n]/g, "")}`,
    html: `<h2>Almost there, ${escapeHtml(purchaserReg.name)}!</h2>
      <p>You're one step from securing your spot on <strong>${escapeHtml(course.title)}</strong>.</p>
      <p><a href="${resumeUrl}">Complete your payment</a></p>
      <p>If that link doesn't work, copy and paste this into your browser: ${resumeUrl}</p>
      <p>If you didn't mean to start this registration, you can safely ignore this email — nothing is charged until payment is completed.</p>
      <p>— The Baseline Skills team</p>`,
  });

  if (available.length > 1) {
    return res.redirect(`/register/choose-payment?reg=${purchaserReg.id}`);
  }

  return startCheckout(res, available[0], course, purchaserReg);
});

// Maps a payment provider name to the registration column that stores its
// order/transaction id — three providers, three separate id shapes
// (Paddle transaction ids, PayPal order ids, Razorpay order ids), kept as
// one small shared lookup rather than repeating this branch at each of
// the several places that need to read or write the right field for
// whichever provider a given registration is actually using.
function orderIdFieldFor(providerName) {
  if (providerName === "paddle") return "paddleTransactionId";
  if (providerName === "razorpay") return "razorpayOrderId";
  return "paypalOrderId";
}

async function startCheckout(res, providerName, course, registration) {
  try {
    const order = await payments.createOrder(providerName, { course, registration });
    const orderIdField = orderIdFieldFor(providerName);
    const patch = { paymentProvider: providerName, [orderIdField]: order.orderId };
    // Razorpay's checkout widget needs the INR paise amount passed to it
    // directly on the client side — stashed here alongside the order id
    // rather than recomputed later, since it was already computed once
    // (with the EUR_TO_INR_RATE at the moment of order creation) and
    // recomputing it later could disagree if that rate changes in the
    // meantime.
    if (providerName === "razorpay") patch.razorpayAmountPaise = order.amountPaise;
    await store.update("registrations", registration.id, patch);
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

// ---- Resume-checkout link: lets someone come back and pay for a
// pending_payment registration without re-entering their course and
// personal details. Before this existed, the only path to checkout was
// the one-time redirect immediately after submitting the registration
// form — closing that tab (or the checkout page itself) for any reason
// left no way back in except starting the whole form over, and, worse,
// resubmitting within PENDING_GRACE_MINUTES would now correctly be
// blocked as a duplicate with nowhere else to go.
//
// Split into GET (show what's about to be charged, so the person can
// confirm it's really them and these are still the right details before
// anything happens) and POST (actually proceed) rather than going
// straight to checkout on a single click — a plain link/GET request can
// be triggered by something other than the person deliberately choosing
// to pay (a link preview crawler, browser prefetching, or just someone
// clicking a stale old email by accident long after they'd sorted things
// out another way), so it shouldn't be the trigger for a real order being
// created.
// Reconciles a still-pending_payment registration's PREVIOUS order
// against the payment provider directly, before letting the resume flow
// create a brand-new one. Closes a real double-charge gap: this app
// captures payment via its own webhook handler (CHECKOUT.ORDER.APPROVED
// -> our own captureOrder call, further down), not the instant the buyer
// approves on PayPal's side — so if the follow-up
// PAYMENT.CAPTURE.COMPLETED webhook that would normally confirm that
// capture here is lost or delayed, the registration stays stuck at
// pending_payment even though the money has already genuinely been
// taken. Found after exactly that happened: a customer in that state
// retried payment and risked being charged a second time for the same
// registration. Returns the (possibly now-confirmed) registration —
// callers should use the returned value, not assume the one they passed
// in is still accurate.
async function reconcileExistingOrder(reg) {
  const orderIdField = orderIdFieldFor(reg.paymentProvider);
  const existingOrderId = reg[orderIdField];
  if (!reg.paymentProvider || !existingOrderId) return reg;
  try {
    const result = await payments.getOrderStatus(reg.paymentProvider, existingOrderId);
    if (result.supported && result.captured) {
      console.warn(`[registration] reconciled ${reg.id}: provider reports order ${existingOrderId} already captured, but our webhook confirmation never landed — confirming now instead of allowing a retry that could charge a second time.`);
      return await finalizeRegistration(reg.id, { viaFallback: false });
    }
  } catch (err) {
    // Fail open: an API hiccup checking status shouldn't itself block a
    // legitimate retry — this check is best-effort, not a hard guarantee.
    // See the admin "Check payment status" action for a manual fallback
    // covering exactly this case.
    console.error(`[registration] order status reconciliation failed for ${reg.id}:`, err.message);
  }
  return reg;
}

router.get("/register/resume/:regId", async (req, res) => {
  let reg = store.findOne("registrations", (r) => r.id === req.params.regId);
  if (!reg) return res.status(404).render("404", { title: res.locals.t('title_registration_not_found') });
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  if (!course) return res.status(404).render("404", { title: res.locals.t('title_course_not_found') });
  if (reg.status === "pending_payment") reg = await reconcileExistingOrder(reg);
  if (reg.status !== "pending_payment") {
    // Already confirmed (possibly just now, by the reconciliation check
    // above), cancelled, refunded, or invoice_pending — nothing left to
    // resume. Send them to the page that already knows how to display
    // whatever their actual current status is, rather than a second,
    // different way of saying the same thing.
    return res.redirect(`/register/success?reg=${reg.id}`);
  }
  res.render("resume-confirm", { title: res.locals.t('resume_title') + " — Baseline Skills", noindex: true, registration: reg, course });
});

// Recomputes what a registration should be charged, for the resume flow's
// coupon support — keeps everything else about the registration fixed
// (course, session, delivery mode, participant count, exam selection),
// only ever changing the coupon applied to it. Mirrors the exact same
// calculatePricing/effectiveDiscountPercent/calculateVat calls the
// original registration submission uses (see the main POST handler
// above), so a coupon applied here produces exactly the same numbers it
// would have if it had been entered the first time round.
function repriceForResume(course, reg, couponCode) {
  const couponValidation = couponCode ? discounts.validateCouponCode(couponCode, course.id, reg.sessionStartDate) : null;
  const validCoupon = couponValidation && couponValidation.valid ? couponCode : null;
  const examProduct = reg.certificationExamId ? store.findOne("certification_exams", (e) => e.id === reg.certificationExamId) : null;
  const examDiscountPercent = discounts.effectiveDiscountPercent(course, reg.sessionStartDate, validCoupon);
  const examFinalPriceCents = examProduct ? Math.round(examProduct.priceCents * (1 - examDiscountPercent / 100)) : 0;
  const priceResult = pricing.calculatePricing({ course, deliveryMode: reg.deliveryMode, participantCount: reg.participantCount || 1, sessionStartDate: reg.sessionStartDate, couponCode: validCoupon });
  const taxableAmountCents = priceResult.finalTotalCents + examFinalPriceCents;
  const { rate: vatRatePercent, vatAmountCents } = vat.calculateVat(taxableAmountCents, reg.vatCountry || "");
  const grandTotalCents = taxableAmountCents + vatAmountCents;
  return { couponValidation, priceResult, examFinalPriceCents, vatRatePercent, vatAmountCents, grandTotalCents };
}

// Live preview for the "Apply" button on the resume-confirm page — never
// trusted for the actual charge (that's repriceForResume, called again,
// independently, when the POST below actually proceeds), only for showing
// the visitor what a coupon would do before they commit to it.
router.get("/register/resume/:regId/pricing-preview", (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.params.regId);
  if (!reg || reg.status !== "pending_payment") return res.status(404).json({ error: "Not found" });
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  if (!course) return res.status(404).json({ error: "Not found" });
  const couponCode = (req.query.couponCode || "").trim();
  const { couponValidation, priceResult, examFinalPriceCents, vatRatePercent, vatAmountCents, grandTotalCents } = repriceForResume(course, reg, couponCode);
  res.json({
    couponValid: couponCode ? !!(couponValidation && couponValidation.valid) : null,
    couponReason: couponValidation && !couponValidation.valid ? res.locals.t("coupon_reason_" + couponValidation.reasonKey) : null,
    currencySymbol: currencySymbol(course.currency),
    baseTotalCents: priceResult.baseTotalCents,
    discountPercent: priceResult.discountPercent,
    discountAmountCents: priceResult.discountAmountCents,
    examPriceCents: examFinalPriceCents,
    vatRatePercent, vatAmountCents, grandTotalCents,
  });
});

router.post("/register/resume/:regId", async (req, res) => {
  let reg = store.findOne("registrations", (r) => r.id === req.params.regId);
  if (!reg) return res.status(404).render("404", { title: res.locals.t('title_registration_not_found') });
  if (reg.status !== "pending_payment") {
    return res.redirect(`/register/success?reg=${reg.id}`);
  }
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  if (!course) return res.status(404).render("404", { title: res.locals.t('title_course_not_found') });

  // Safety-critical: re-check with the provider before creating any new
  // order. See reconcileExistingOrder above — this is what actually
  // prevents a second charge; the GET route's own check is just an early,
  // friendlier version of the same thing, not a substitute for this one,
  // since a GET happening earlier doesn't guarantee nothing changed
  // (webhook arriving, say) by the time this POST actually runs.
  reg = await reconcileExistingOrder(reg);
  if (reg.status !== "pending_payment") {
    return res.redirect(`/register/success?reg=${reg.id}`);
  }

  // Apply a coupon to the actual charge, not just the preview.
  // Re-validated and recomputed here independently, from scratch — never
  // trusting whatever total the "Apply" button's fetch call last showed
  // the browser, the same "browser is never the authority for the charged
  // amount" principle the original registration submission already
  // follows. An invalid coupon here re-renders this same confirmation
  // page with the error, rather than silently ignoring it and proceeding
  // to charge the old price — a coupon someone deliberately entered
  // failing silently would be a worse experience than being blocked.
  const couponCode = (req.body.couponCode || "").trim();
  let updatedReg = reg;
  if (couponCode) {
    const { couponValidation, priceResult, examFinalPriceCents, vatAmountCents, grandTotalCents } = repriceForResume(course, reg, couponCode);
    if (!couponValidation || !couponValidation.valid) {
      return res.render("resume-confirm", {
        title: res.locals.t('resume_title') + " — Baseline Skills", noindex: true, registration: reg, course,
        couponError: res.locals.t("coupon_reason_" + (couponValidation ? couponValidation.reasonKey : "code_not_found")),
        appliedCouponCode: couponCode,
      });
    }
    updatedReg = store.update("registrations", reg.id, {
      priceCentsCharged: grandTotalCents,
      baseTotalCents: priceResult.baseTotalCents,
      groupDiscountPercent: priceResult.discountPercent,
      groupDiscountAmountCents: priceResult.discountAmountCents,
      examPriceCentsCharged: reg.certificationExamId ? examFinalPriceCents : reg.examPriceCentsCharged,
      vatAmountCents,
    });
  }

  // Reuse whichever provider they were already on, if there was one and
  // it's still configured, rather than making them choose again for no
  // reason.
  if (updatedReg.paymentProvider && payments.isConfigured(updatedReg.paymentProvider)) {
    return startCheckout(res, updatedReg.paymentProvider, course, updatedReg);
  }
  const available = payments.availableProvidersForCountry(updatedReg.vatCountry);
  if (available.length === 0) {
    // No provider configured at all right now — same invoice-pending
    // fallback the original flow uses, rather than a dead end.
    await finalizeRegistration(updatedReg.id, { viaFallback: true });
    return res.redirect(`/register/success?reg=${updatedReg.id}`);
  }
  if (available.length > 1) return res.redirect(`/register/choose-payment?reg=${updatedReg.id}`);
  return startCheckout(res, available[0], course, updatedReg);
});

router.get("/register/choose-payment", (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  if (!reg) return res.status(404).render("404", { title: res.locals.t('title_registration_not_found') });
  res.render("choose-payment", { title: res.locals.t('choose_payment_title') + " — Baseline Skills", registration: reg, providers: payments.availableProvidersForCountry(reg.vatCountry) });
});

router.post("/register/choose-payment", async (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.body.reg);
  if (!reg) return res.status(404).render("404", { title: res.locals.t('title_registration_not_found') });
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  if (!payments.isValidProvider(req.body.provider) || !payments.isConfigured(req.body.provider)) {
    return res.redirect(`/register/choose-payment?reg=${reg.id}`);
  }
  return startCheckout(res, req.body.provider, course, reg);
});

// ---- Checkout page: loads Paddle.js and opens the overlay for this registration's transaction ----
router.get("/register/checkout/:provider", (req, res) => {
  const providerName = req.params.provider;
  if (!payments.isValidProvider(providerName)) return res.status(404).render("404", { title: res.locals.t('title_unknown_payment_method') });
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  const orderIdField = orderIdFieldFor(providerName);
  if (!reg || !reg[orderIdField]) return res.status(404).render("404", { title: res.locals.t('title_registration_not_found') });
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  const clientConfig = payments.getClientConfig(providerName);
  res.render("checkout", { title: res.locals.t('title_complete_payment') + " — Baseline Skills", noindex: true, registration: reg, course, clientConfig, provider: providerName, orderId: reg[orderIdField] });
});

// ---- Shared finalize step: used by both the Paddle webhook and the no-Paddle fallback ----
// Releases the seats a registration's own submission reserved, back onto
// its session. Only meaningful on the purchaser's row: seats are decremented
// exactly once per submission, using the purchaser row's participantCount
// (see the seat-availability check above, and how each row is built) — a
// non-purchaser participant's row always carries participantCount: 1
// regardless of true group size, so releasing based on that row instead
// would under- or over-release the session's seat count. Safe to call
// on a row with no real session (sessionStartDate === "") or an
// unlimited-seats session (seatsLeft null/undefined) — it's a no-op then.
function releaseSeatsForRegistration(reg) {
  if (!reg.isPurchaser || !reg.sessionStartDate) return;
  const course = store.findOne("courses", (c) => c.id === reg.courseId);
  const session = course && course.sessions.find((s) => s.startDate === reg.sessionStartDate);
  if (session && session.seatsLeft !== null && session.seatsLeft !== undefined) {
    store.raw.prepare(`UPDATE sessions SET seatsLeft = seatsLeft + ? WHERE id = ?`).run(reg.participantCount || 1, session.id);
  }
}

// Cancels a registration. Cancelling the purchaser's row cancels the whole
// group with it (every sibling sharing groupRegistrationId) and releases
// the seats their shared submission reserved, since the purchaser's payment
// covers the group as a unit — there's no partial-refund/partial-seat-
// release concept in this codebase, so a partial cancellation would leave
// the remaining siblings' access resting on a payment that no longer
// reflects their actual group size. Cancelling a single non-purchaser
// participant's row, by contrast, only removes that one person — it
// intentionally leaves the group's seats and the purchaser's row alone.
function cancelRegistrationGroup(registrationId) {
  const reg = store.findOne("registrations", (r) => r.id === registrationId);
  if (!reg) return null;
  if (reg.status === "cancelled" || reg.status === "refunded") return reg; // already released — don't double-release seats

  if (reg.isPurchaser) {
    releaseSeatsForRegistration(reg);
    const siblings = reg.groupRegistrationId
      ? store.readAll("registrations").filter((r) => r.groupRegistrationId === reg.groupRegistrationId && r.id !== reg.id && r.status !== "cancelled" && r.status !== "refunded")
      : [];
    for (const sibling of siblings) store.update("registrations", sibling.id, { status: "cancelled" });
  }
  return store.update("registrations", registrationId, { status: "cancelled" });
}

// Lazily sweeps registrations abandoned before ever completing payment —
// run on the next registration attempt rather than a background job, since
// this app has no scheduler. Only ever touches a purchaser's row still
// stuck in pending_payment past PENDING_GRACE_MINUTES: cancelling it here
// (rather than just excluding it from the duplicate check, as an earlier,
// narrower version of this fix did) also releases the seat it reserved, so
// an abandoned checkout doesn't quietly starve a session's real capacity.
const PENDING_GRACE_MINUTES = 30;
function sweepAbandonedPendingRegistrations() {
  const graceThresholdIso = new Date(Date.now() - PENDING_GRACE_MINUTES * 60 * 1000).toISOString();
  const stale = store.readAll("registrations").filter((r) => r.isPurchaser && r.status === "pending_payment" && r.createdAt < graceThresholdIso);
  for (const reg of stale) cancelRegistrationGroup(reg.id);
}

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
  if (!reg) return res.status(404).render("404", { title: res.locals.t('title_registration_not_found') });

  // The webhook is the authoritative confirmation path (see below) — this
  // redirect-based check exists only as a fallback in case the webhook is
  // delayed, since Paddle's overlay closing doesn't itself guarantee the
  // webhook has already been delivered and processed.
  const finalReg = store.findOne("registrations", (r) => r.id === regId);
  const course = store.findOne("courses", (c) => c.id === finalReg.courseId);
  res.render("register-success", { title: res.locals.t('title_registration_confirmed') + " — Baseline Skills", noindex: true, registration: finalReg, course });
});

router.get("/register/cancel", (req, res) => {
  const reg = store.findOne("registrations", (r) => r.id === req.query.reg);
  res.render("register-cancel", { title: res.locals.t('title_registration_not_completed') + " — Baseline Skills", noindex: true, registration: reg });
});

// Pairs with checkout.ejs's onError handler above — logs an unhandled
// PayPal SDK error server-side, since a real customer hitting this has no
// DevTools open for anyone to ask them to check, unlike how this exact
// class of issue got diagnosed during testing. Deliberately just logs and
// returns 204: this is a diagnostic breadcrumb, not something that should
// ever itself fail loudly back to an already-failing checkout page.
router.post("/register/client-error", (req, res) => {
  const { reg, provider, message } = req.body || {};
  console.error(`[client-error] reg=${reg} provider=${provider}:`, message);
  res.status(204).end();
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

// ---- Razorpay webhook — the authoritative payment-confirmation path ----
// Razorpay signs the raw request body with HMAC-SHA256 (see
// lib/payments/razorpay.js's verifyWebhookSignature), the same local-HMAC
// shape as Paddle's webhook above, not an API round-trip like PayPal's —
// hence express.raw() here too, for the same reason.
router.post("/webhooks/razorpay", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");
  const verification = payments.razorpay.verifyWebhookSignature(req.headers, rawBody);
  if (!verification.ok) {
    console.error("[razorpay webhook] signature verification failed:", verification.reason);
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send("Invalid payload");
  }

  if (event.event === "payment.captured") {
    const orderId = event.payload && event.payload.payment && event.payload.payment.entity && event.payload.payment.entity.order_id;
    const reg = orderId ? store.findOne("registrations", (r) => r.razorpayOrderId === orderId) : null;
    if (reg) {
      await finalizeRegistration(reg.id, { viaFallback: false });
    } else {
      console.warn("[razorpay webhook] payment.captured with no matching registration for order", orderId);
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;
module.exports.finalizeRegistration = finalizeRegistration;
module.exports.cancelRegistrationGroup = cancelRegistrationGroup;
module.exports.orderIdFieldFor = orderIdFieldFor;
