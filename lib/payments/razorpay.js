// Razorpay: the India-domestic payment gateway, added alongside PayPal
// after discovering that PayPal has been structurally unable to process
// India-to-India transactions since 2021 (an RBI regulatory restriction,
// not a bug or account misconfiguration -- see availableProvidersForCountry
// in ./index.js, which routes India-based buyers here instead of PayPal
// rather than offering both to everyone).
//
// Razorpay is fundamentally an INR gateway for a standard India-registered
// merchant account like this one -- it does not accept charges in EUR the
// way PayPal does. Course prices throughout this app are stored in EUR
// (registration.priceCentsCharged), so this module converts to INR paise
// at the moment of order creation using a single, admin-configurable
// exchange rate (EUR_TO_INR_RATE) rather than a live FX API or a separate
// INR price per course -- a deliberate simplification to get this
// genuinely working now. If EUR/INR volatility becomes a real problem,
// replacing this with a live rate lookup or manual per-course INR pricing
// is the natural next step, not a rewrite of this module's structure.
const crypto = require("crypto");

function isConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function authHeader() {
  const token = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  return `Basic ${token}`;
}

function eurCentsToInrPaise(eurCents) {
  const rate = Number(process.env.EUR_TO_INR_RATE);
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("EUR_TO_INR_RATE is not set to a valid positive number -- required to convert EUR pricing to INR for Razorpay orders.");
  }
  // eurCents is hundredths of a euro; rate is INR per 1 EUR; result is
  // paise (hundredths of a rupee) -- same two-step unit conversion either
  // way: cents -> euros -> rupees -> paise, done in one multiply since
  // the /100 and *100 cancel out.
  return Math.round(eurCents * rate);
}

async function createOrder({ course, registration }) {
  const amountPaise = eurCentsToInrPaise(registration.priceCentsCharged);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: registration.id,
      // Auto-capture: Razorpay has no separate manual-capture step to
      // mirror PayPal's webhook-driven capture in this app, since
      // Razorpay's own webhook (payment.captured) is already the
      // authoritative confirmation this app relies on -- capturing
      // automatically here doesn't weaken that, it just means there's
      // one fewer state for an order to get stuck in before the webhook
      // can confirm it.
      payment_capture: 1,
      notes: { registrationId: registration.id, courseId: course.id },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[razorpay] order creation failed:", res.status, errText);
    throw new Error(`Razorpay order creation failed (${res.status})`);
  }
  const json = await res.json();
  return { orderId: json.id, amountPaise };
}

// Razorpay signs the RAW webhook body (not the parsed/re-serialized JSON,
// which could differ in whitespace or key order from what was actually
// sent and would break this check) -- the route registering this must
// use express.raw(), the same way this app's existing Paddle webhook
// route already does, and for the same reason.
function verifyWebhookSignature(headers, rawBody) {
  const signature = headers["x-razorpay-signature"];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!signature || !secret) return { ok: false, reason: "missing_signature_or_secret" };
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  const ok = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  return ok ? { ok: true, reason: "SUCCESS" } : { ok: false, reason: "signature_mismatch" };
}

// Mirrors paypal.js's getOrderStatus -- queries Razorpay directly for
// whether this order was actually captured, so the same resume-flow
// reconciliation check that prevents a double charge on the PayPal side
// (see reconcileExistingOrder in routes/registration.js) works for
// Razorpay too, not just PayPal.
async function getOrderStatus(orderId) {
  const res = await fetch(`https://api.razorpay.com/v1/orders/${orderId}/payments`, {
    method: "GET",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[razorpay] order status lookup failed:", res.status, errText);
    throw new Error(`Razorpay order status lookup failed (${res.status})`);
  }
  const json = await res.json();
  const items = json.items || [];
  const captured = items.find((p) => p.status === "captured");
  return {
    status: captured ? "captured" : (items[0] && items[0].status) || "created",
    captured: !!captured,
    captureId: captured ? captured.id : null,
  };
}

function getClientConfig() {
  // Only the public key ID -- never the key secret, same principle as
  // PayPal's getClientConfig only ever exposing the client ID.
  return { keyId: process.env.RAZORPAY_KEY_ID };
}

module.exports = { isConfigured, createOrder, verifyWebhookSignature, getOrderStatus, getClientConfig };
