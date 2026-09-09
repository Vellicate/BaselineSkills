const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const store = require("../lib/db");
const { sendMail, escapeHtml } = require("../lib/mailer");
const { newId } = require("../lib/id");
const payments = require("../lib/payments");
const discounts = require("../lib/discounts");
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
  const sessionStartDate = req.query.session || (course.sessions[0] && course.sessions[0].startDate) || "";
  const discountInfo = discounts.earlyBirdForSession(sessionStartDate);
  const examProduct = store.findOne("certification_exams", (e) => e.courseId === course.id);
  const examDiscountPercent = discounts.effectiveDiscountPercent(course, sessionStartDate);
  const examFinalPriceCents = examProduct ? Math.round(examProduct.priceCents * (1 - examDiscountPercent / 100)) : null;
  res.render("register", {
    title: `Register — ${course.title}`, course,
    finalPrice: discounts.finalPriceCentsForSession(course, sessionStartDate),
    discountInfo, selectedSessionStartDate: sessionStartDate,
    examProduct, examFinalPriceCents,
  });
});

// ---- Submit registration ----
router.post("/courses/:slug/register", regRateLimiter, async (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: "Course not found" });

  const { name, email, phone, address, company, role, sessionStartDate, deliveryMode, notes, addExam } = req.body;
  const resolvedSessionStartDate = sessionStartDate || (course.sessions[0] && course.sessions[0].startDate) || "";
  const discountInfo = discounts.earlyBirdForSession(resolvedSessionStartDate);
  const finalPrice = discounts.finalPriceCentsForSession(course, resolvedSessionStartDate);
  const examProduct = store.findOne("certification_exams", (e) => e.courseId === course.id);
  const examDiscountPercent = discounts.effectiveDiscountPercent(course, resolvedSessionStartDate);
  const examFinalPriceCents = examProduct ? Math.round(examProduct.priceCents * (1 - examDiscountPercent / 100)) : null;
  const examSelected = !!addExam && !!examProduct;

  if (!name || !email) {
    return res.status(400).render("register", {
      title: `Register — ${course.title}`, course, finalPrice, discountInfo, selectedSessionStartDate: resolvedSessionStartDate,
      examProduct, examFinalPriceCents,
      error: "Name and email are required.", form: req.body,
    });
  }

  // Duplicate-registration check: the same email registering again for the
  // same course AND the same specific session is treated as an accidental
  // resubmission (double-click, back-button) and blocked — but a different
  // session of the same course is a genuinely different registration and
  // is allowed. A prior registration that's since been cancelled/refunded
  // doesn't count as a block, since re-registering after cancelling is a
  // legitimate case (the status values don't exist yet in this phase, but
  // the check is written to already handle them correctly once they do,
  // rather than needing rework later).
  const existingRegistration = store.findOne("registrations", (r) =>
    r.courseId === course.id &&
    r.email.toLowerCase() === email.toLowerCase() &&
    r.sessionStartDate === resolvedSessionStartDate &&
    r.status !== "cancelled" && r.status !== "refunded"
  );
  if (existingRegistration) {
    return res.status(400).render("register", {
      title: `Register — ${course.title}`, course, finalPrice, discountInfo, selectedSessionStartDate: resolvedSessionStartDate,
      examProduct, examFinalPriceCents,
      error: `You're already registered for this session (${resolvedSessionStartDate}) with this email address. If you need to change or cancel your existing registration, please contact us.`,
      form: req.body,
    });
  }

  // Anonymous registration auto-creates a real learner profile (Master
  // Prompt Section 12) rather than leaving learnerId null until Phase 2's
  // signup flow is used separately — an anonymous visitor should never be
  // asked to sign up again for something they already gave their name and
  // email for. If an account for this email already exists (they registered
  // before, or signed up separately), link to it instead of creating a
  // second one, which the email UNIQUE constraint wouldn't allow anyway.
  let effectiveLearnerId = req.session.learnerId || null;
  let newAccountCreated = false;
  let passwordSetToken = null;

  if (!effectiveLearnerId) {
    const existingLearner = store.findOne("learners", (l) => l.email.toLowerCase() === email.toLowerCase());
    if (existingLearner) {
      effectiveLearnerId = existingLearner.id;
    } else {
      passwordSetToken = crypto.randomBytes(32).toString("hex");
      const newLearner = store.insert("learners", {
        id: newId("learner"),
        email: email.toLowerCase(),
        passwordHash: null,
        name, country: "", phone: "",
        passwordResetToken: passwordSetToken,
        passwordResetExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      });
      effectiveLearnerId = newLearner.id;
      newAccountCreated = true;
    }
  }

  const registration = {
    id: newId("reg"),
    courseId: course.id,
    courseTitle: course.title,
    learnerId: effectiveLearnerId,
    name, email, phone: phone || "", address: address || "", company: company || "", role: role || "",
    sessionStartDate: resolvedSessionStartDate,
    deliveryMode: deliveryMode || (course.sessions[0] && course.sessions[0].mode) || "",
    notes: notes || "",
    priceCentsCharged: finalPrice + (examSelected ? examFinalPriceCents : 0),
    certificationExamId: examSelected ? examProduct.id : null,
    examPriceCentsCharged: examSelected ? examFinalPriceCents : null,
    currency: course.currency,
    status: "pending_payment",
    createdAt: new Date().toISOString(),
  };

  // Referral attribution — last-touch, per the referral design in the
  // Pricing & Commissions work: whichever code is currently in the
  // session at the moment of registration gets the credit.
  if (req.session.refCode) {
    const refCodeRow = store.findOne("referral_codes", (r) => r.code === req.session.refCode);
    if (refCodeRow) {
      registration.referredById = refCodeRow.ownerId;
      registration.referralType = refCodeRow.ownerType;
    }
  }

  await store.insert("registrations", registration);

  const available = payments.availableProviders();

  if (available.length === 0) {
    // No live payment credentials configured for either provider — fall
    // back to an "invoice pending" path so the rest of the pipeline (file
    // storage + emails) still runs fully end to end.
    await finalizeRegistration(registration.id, { viaFallback: true });
    return res.redirect(`/register/success?reg=${registration.id}`);
  }

  if (available.length > 1) {
    // Both configured — let the learner choose, rather than silently
    // picking one for them (Master Prompt Section 12 explicitly asks for
    // this to be a real choice, not just "Paddle, with PayPal as a
    // theoretical alternative nobody can actually pick").
    return res.redirect(`/register/choose-payment?reg=${registration.id}`);
  }

  return startCheckout(res, available[0], course, registration);
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
  const updated = await store.update("registrations", registrationId, {
    status: opts.viaFallback ? "invoice_pending" : "confirmed",
    confirmedAt: new Date().toISOString(),
  });

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
  // at the moment of confirmed purchase, so the learner has something real
  // to fill in from their account page rather than a stage that exists
  // in the schema but nothing ever populates.
  if (reg.learnerId) {
    const existingPurchaseFeedback = store.findOne("feedback", (f) => f.learnerId === reg.learnerId && f.courseId === reg.courseId && f.stage === "purchase");
    if (!existingPurchaseFeedback) {
      store.insert("feedback", {
        id: newId("feedback"), learnerId: reg.learnerId, courseId: reg.courseId,
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

  // If this registration is tied to a learner account with no password set
  // yet (created automatically for an anonymous registrant, per Section
  // 12), include a set-password link in their confirmation email — looked
  // up here directly rather than threaded through as a parameter, since
  // this function runs from both the immediate fallback path and the async
  // Paddle webhook, and only the learner record itself reliably carries
  // this state across both.
  let setPasswordNote = "";
  if (reg.learnerId) {
    const learner = store.findOne("learners", (l) => l.id === reg.learnerId);
    if (learner && !learner.passwordHash && learner.passwordResetToken) {
      const setPasswordUrl = `${process.env.APP_BASE_URL || "https://baselineskills.com"}/set-password?token=${learner.passwordResetToken}`;
      setPasswordNote = `<p>We've set up an account for you so you can track this registration — <a href="${setPasswordUrl}">set a password</a> to log in any time.</p>`;
    }
  }

  await sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New registration — ${courseTitle.replace(/[\r\n]/g, "")} (${escapeHtml(reg.name).replace(/[\r\n]/g, "")})`,
    html: `<h2>New course registration</h2>
      <p><strong>${escapeHtml(reg.name)}</strong> (${escapeHtml(reg.email)}) registered for <strong>${courseTitle}</strong>.</p>
      <ul>
        <li>Company: ${escapeHtml(reg.company) || "n/a"}</li>
        <li>Role: ${escapeHtml(reg.role) || "n/a"}</li>
        <li>Session: ${escapeHtml(reg.sessionStartDate)} (${escapeHtml(reg.deliveryMode)})</li>
        <li>Amount: ${escapeHtml(reg.currency)} ${priceDisplay}</li>
        <li>Status: ${escapeHtml(updated.status)}</li>
      </ul>
      ${paymentNote}`,
  });

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
      ${setPasswordNote}
      <p>We'll be in touch with joining instructions closer to the session date.</p>
      <p>— The Baseline Skills team</p>`,
  });

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
