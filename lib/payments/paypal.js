// PayPal REST API (Orders v2) — same "never trust browser-only success"
// principle as Paddle: the server creates the order, the client renders
// PayPal's own approval UI, and a webhook (not the browser redirect) is
// the authoritative confirmation. Env vars: PAYPAL_CLIENT_ID,
// PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT, PAYPAL_WEBHOOK_ID (PayPal
// verifies webhook signatures against a registered webhook ID via its own
// verification API, not a local HMAC computation like Paddle's).

function isConfigured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function apiBaseUrl() {
  const env = (process.env.PAYPAL_ENVIRONMENT || "sandbox").toLowerCase();
  return env === "production" || env === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function getClientConfig() {
  const env = (process.env.PAYPAL_ENVIRONMENT || "sandbox").toLowerCase();
  return {
    clientId: process.env.PAYPAL_CLIENT_ID || null,
    environment: env === "production" || env === "live" ? "production" : "sandbox",
  };
}

let cachedToken = null; // { value, expiresAt } — avoids a token request on every order
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const basicAuth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${apiBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth token request failed (${res.status})`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return cachedToken.value;
}

// Creates a PayPal order for this registration's full amount (course + exam,
// if selected) — same amount already computed and stored on the
// registration, not recalculated here.
async function createOrder({ course, registration }) {
  if (!isConfigured()) return { configured: false };

  const amount = (registration.priceCentsCharged / 100).toFixed(2);
  const description = registration.certificationExamId
    ? `${course.title} — course + certification exam`
    : `${course.title} — course registration`;

  const token = await getAccessToken();
  const res = await fetch(`${apiBaseUrl()}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          description: description.slice(0, 127), // PayPal's own field length limit
          custom_id: registration.id,
          amount: {
            currency_code: (course.currency || "USD").toUpperCase(),
            value: amount,
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[paypal] order creation failed:", res.status, errText);
    throw new Error(`PayPal order creation failed (${res.status})`);
  }

  const json = await res.json();
  return { configured: true, orderId: json.id };
}

// PayPal's own webhook signature verification API — unlike Paddle's local
// HMAC computation, PayPal requires an API call to confirm a webhook is
// genuine, using the transmission headers PayPal includes on every webhook
// request plus a registered PAYPAL_WEBHOOK_ID.
async function verifyWebhookSignature(headers, body) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return { ok: false, reason: "PAYPAL_WEBHOOK_ID not configured" };

  const token = await getAccessToken();
  const res = await fetch(`${apiBaseUrl()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: body,
    }),
  });
  if (!res.ok) return { ok: false, reason: `verification API returned ${res.status}` };
  const json = await res.json();
  return { ok: json.verification_status === "SUCCESS", reason: json.verification_status };
}

// PayPal requires an explicit capture call after the buyer approves —
// unlike Paddle, where the transaction itself completes more directly.
// Triggered from the webhook (CHECKOUT.ORDER.APPROVED), not the browser
// redirect, for the same "never trust the browser alone" reason as
// everywhere else in this app's payment handling.
async function captureOrder(orderId) {
  const token = await getAccessToken();
  const res = await fetch(`${apiBaseUrl()}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[paypal] order capture failed:", res.status, errText);
    throw new Error(`PayPal order capture failed (${res.status})`);
  }
  return res.json();
}

module.exports = { isConfigured, createOrder, captureOrder, getClientConfig, verifyWebhookSignature };
