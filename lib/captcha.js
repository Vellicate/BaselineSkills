const crypto = require("crypto");

// A simple, self-hosted "prove you're human" check — no external service,
// no API keys, works immediately. The expected answer lives server-side
// in the session, never exposed to the client. If the business later
// wants a real CAPTCHA provider (reCAPTCHA, hCaptcha), this is the single
// place to swap the implementation — the calling routes only care about
// generateCaptcha()/verifyCaptcha(), not how the check itself works.
function generateCaptcha(session) {
  const a = crypto.randomInt(3, 10);
  const b = crypto.randomInt(3, 10);
  session.captchaAnswer = a + b;
  return { question: `What is ${a} + ${b}?` };
}

function verifyCaptcha(session, submittedAnswer) {
  const expected = session.captchaAnswer;
  session.captchaAnswer = null; // single-use — a fresh challenge is generated on every page load anyway
  if (expected == null) return false;
  return Number(submittedAnswer) === expected;
}

module.exports = { generateCaptcha, verifyCaptcha };
