// Sends email via SMTP if configured (SMTP_HOST/PORT/USER/PASS in .env).
// If not configured, logs the full email content to console and to
// email-log.json instead of failing — so registration flow always
// completes end-to-end in development, and switching to real delivery
// later is just a matter of setting the env vars, no code changes needed.

const nodemailer = require("nodemailer");
const store = require("./db");

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

function logToFile(entry) {
  try {
    // Previously wrote directly to email-log.json, bypassing the SQLite
    // migration from Phase 1 entirely — every email since then was logged
    // somewhere the database (and any admin reporting built on top of it)
    // couldn't see. Routed through the same store.insert every other part
    // of this app uses, so the emailLog table actually stays current.
    store.insert("email-log", { ...entry, loggedAt: new Date().toISOString() });
  } catch (e) {
    // A failure to log an email is never worth crashing whatever route
    // triggered it (registration, brochure request, etc.) — same
    // fail-open philosophy as the rest of this app's mailer.
    console.error("[mailer] failed to write email log:", e.message);
  }
}

async function sendMail({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM || "Baseline Skills <no-reply@baselineskills.example>";

  if (!isConfigured()) {
    console.log(`\n[mailer] SMTP not configured — logging email instead of sending.`);
    console.log(`[mailer] To: ${to}\n[mailer] Subject: ${subject}`);
    logToFile({ to, from, subject, html, text, delivered: false, reason: "SMTP not configured" });
    return { delivered: false, reason: "SMTP not configured" };
  }

  try {
    await getTransporter().sendMail({ from, to, subject, html, text });
    logToFile({ to, from, subject, delivered: true });
    return { delivered: true };
  } catch (err) {
    console.error("[mailer] send failed:", err.message);
    logToFile({ to, from, subject, delivered: false, reason: err.message });
    return { delivered: false, reason: err.message };
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { sendMail, isConfigured, escapeHtml };

