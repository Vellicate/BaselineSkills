require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");

// Creates the SQLite database + tables if they don't exist yet, then
// imports existing JSON data (or bundled seeds on a completely fresh
// install) — safe to run on every boot, since it skips any table that
// already has rows.
require("./lib/migrate-json-to-sqlite").run();
require("./lib/auth").ensureBootstrapAdmin();

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Basic HTTP security headers on every response. Not a substitute for a
// full policy (e.g. a tuned Content-Security-Policy for this app's actual
// script/style/image sources), but covers the standard low-effort,
// high-value defaults.
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // X-XSS-Protection is deprecated and ignored by modern browsers (which rely
  // on CSP instead), but it's harmless to set for the handful of older
  // browsers that still honor it, and it was explicitly asked for.
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Content-Security-Policy, scoped to the exact external domains this app
  // actually loads resources from (found by grepping every view for a
  // hardcoded https:// reference) rather than either skipping CSP entirely
  // or guessing at a policy that could silently break checkout. 'unsafe-inline'
  // is included for script/style because this app uses inline <script> blocks
  // throughout (the Paddle/PayPal checkout initializers, header/modal
  // interactivity) — a nonce-based policy would be stronger but requires
  // per-render wiring this app doesn't have yet; this is still a real
  // improvement over no CSP at all, blocking arbitrary third-party script
  // injection, framing, and plugin/object embedding.
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.paddle.com https://www.paypal.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://cdn.paddle.com https://www.paypal.com",
    "frame-src https://www.paypal.com",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
  ].join("; "));
  // HSTS only makes sense once traffic is actually served over HTTPS —
  // setting it on a plain HTTP connection (as in local/staging testing)
  // wouldn't reflect reality and could cause issues if the deployment ever
  // temporarily serves HTTP. req.secure correctly accounts for a
  // trust-proxy-aware reverse proxy setup (see the note below this block).
  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));
// Excludes /webhooks/* — those routes need the raw, unparsed request body
// to verify Paddle's HMAC signature and satisfy PayPal's verification API,
// both of which require the exact bytes as sent, not a re-serialized JSON
// object. Each webhook route applies its own express.raw() middleware
// instead. Without this exclusion, this global parser consumes the body
// first, and the route-specific raw parser gets nothing left to capture —
// req.body ends up as an already-parsed object, and "${req.body}" in the
// signature computation silently becomes the string "[object Object]"
// instead of the real payload. This is why Paddle webhook signature
// verification has never actually succeeded, on any payload, until this
// was caught by testing a fully signed webhook end-to-end rather than
// stopping once the request reached the handler at all.
app.use(bodyParser.json({
  type: (req) => !req.path.startsWith("/webhooks/") && req.is("json"),
}));

// If this app runs behind a reverse proxy/load balancer (Netlify, Heroku,
// nginx, etc.), uncomment the line below so req.ip and req.secure reflect
// the real client rather than the proxy. Only enable this if you actually
// control/trust that proxy — otherwise a client can spoof X-Forwarded-For
// and bypass the IP-based rate limiting in lib/security.js.
//
// This also matters for the session cookie below: with NODE_ENV=production,
// the cookie's `secure` flag requires Express to see the connection as
// HTTPS. Behind a TLS-terminating proxy, Express only knows that from the
// X-Forwarded-Proto header, which it only reads when trust proxy is set.
// Skip this in production behind a proxy and logins will silently break —
// the browser won't send a `secure` cookie back over what looks like plain
// HTTP. Render terminates TLS at its own edge and forwards plain HTTP to
// this app, so this MUST be enabled for admin login to work in production.
app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "baseline-skills-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

// Make a few things available to every view without passing them explicitly each time.
app.use((req, res, next) => {
  res.locals.isAdmin = !!(req.session && req.session.adminId);
  res.locals.isLoggedInLearner = !!(req.session && req.session.learnerId);
  res.locals.currentPath = req.path;
  next();
});

app.use("/", require("./routes/public"));
app.use("/", require("./routes/registration"));
app.use("/", require("./routes/auth"));
app.use("/", require("./routes/onboarding"));
app.use("/admin", require("./routes/admin"));

app.use((req, res) => {
  res.status(404).render("404", { title: "Page not found" });
});

// Global error handler — must be registered last, and must take all four
// arguments for Express to recognize it as error-handling middleware
// rather than another normal route. Without this, an uncaught error from
// any route (a bad render call, a thrown exception, anything) falls
// through to Express's own default handler, which renders a full stack
// trace directly to the visitor — confirmed happening for real during
// earlier testing (a course-form render missing a variable, an unhandled
// Multer error) before this handler existed. The real error is always
// logged server-side either way; the visitor only ever sees a generic,
// safe message.
app.use((err, req, res, next) => {
  console.error("[unhandled error]", req.method, req.originalUrl, "\n", err.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).render("500", { title: "Something went wrong — Baseline Skills" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Baseline Skills running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin/login`);
});
