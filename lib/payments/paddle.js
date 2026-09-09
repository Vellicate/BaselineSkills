// Paddle Billing — same provider ReqDrive already uses, same env var
// conventions (PADDLE_API_KEY, PADDLE_CLIENT_TOKEN, PADDLE_ENVIRONMENT,
// PADDLE_WEBHOOK_SECRET). See lib/payments/index.js for the shared
// provider-agnostic interface this implements.

function isConfigured() {
  return !!(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN);
}

function apiBaseUrl() {
  const env = (process.env.PADDLE_ENVIRONMENT || "sandbox").toLowerCase();
  return env === "production" || env === "live"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";
}

function getClientConfig() {
  const env = (process.env.PADDLE_ENVIRONMENT || "sandbox").toLowerCase();
  return {
    clientToken: process.env.PADDLE_CLIENT_TOKEN || null,
    environment: env === "production" || env === "live" ? "production" : "sandbox",
  };
}

// Creates a draft Paddle transaction with a non-catalog (inline) price for
// this specific registration's amount (course + exam, if selected — the
// full amount already computed and stored on the registration itself,
// rather than recalculated here, to avoid any mismatch if the discount
// configuration changes in the moments between registration and this call).
async function createOrder({ course, registration }) {
  if (!isConfigured()) return { configured: false };

  const amount = registration.priceCentsCharged;
  const description = registration.certificationExamId
    ? `${course.title} — course + certification exam`
    : `${course.title} — course registration`;

  const body = {
    items: [
      {
        quantity: 1,
        price: {
          description,
          name: course.title,
          unit_price: {
            amount: String(amount),
            currency_code: (course.currency || "USD").toUpperCase(),
          },
          product: {
            name: course.title,
            tax_category: "standard",
            description: course.summary || course.title,
          },
        },
      },
    ],
    currency_code: (course.currency || "USD").toUpperCase(),
    customer_email: registration.email,
    custom_data: {
      registrationId: registration.id,
      courseId: course.id,
    },
  };

  const res = await fetch(`${apiBaseUrl()}/transactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[paddle] transaction creation failed:", res.status, errText);
    throw new Error(`Paddle transaction creation failed (${res.status})`);
  }

  const json = await res.json();
  return { configured: true, orderId: json.data.id };
}

module.exports = { isConfigured, createOrder, getClientConfig };
