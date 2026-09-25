require("dotenv").config();
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const bodyParser = require("body-parser");
const path = require("path");
const { DATA_DIR } = require("./lib/db");

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
  //
  // frame-src includes 'self' specifically for the LMS course player,
  // which embeds a PDF lesson's own /lms/content/:id/stream URL in a same-
  // origin <iframe> to display it inline — found as a real bug, not a
  // theoretical gap: frame-src (once set explicitly) overrides default-src
  // for framing regardless of origin, so a policy naming only the PayPal
  // checkout frame silently blocked the site's own same-origin PDF viewer
  // too, surfacing to the student as a browser-level "content is blocked"
  // page with no indication it was a CSP header, not a real access denial.
  // connect-src and frame-src list both www.paypal.com (production) and
  // www.sandbox.paypal.com (PAYPAL_ENVIRONMENT=sandbox): PayPal's own SDK
  // script is always loaded from www.paypal.com/sdk/js regardless of mode,
  // but the actual checkout iframe and its background requests are served
  // from the sandbox subdomain while testing. Without the sandbox domain
  // here, the CSP silently blocks PayPal's own checkout frame — surfacing
  // to the buyer as a PayPal popup stuck on a permanent loading spinner,
  // not as an obvious CSP error, found the hard way during sandbox testing.
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.paddle.com https://www.paypal.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://cdn.paddle.com https://www.paypal.com https://www.sandbox.paypal.com",
    "frame-src 'self' https://www.paypal.com https://www.sandbox.paypal.com",
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

// Sessions previously used express-session's default MemoryStore, which
// Express itself warns against in production: it leaks memory over time,
// and every redeploy wipes all active sessions since they only ever
// existed in that one process's RAM (logging out any admin mid-session).
// Stored as flat files under DATA_DIR instead — the same persistent-disk
// location the database and uploads already use — so sessions survive a
// redeploy too, and a fresh session file is just as easy to garbage
// collect as an expired DB row. Deliberately a pure-JS package (no native
// compilation) rather than a SQLite-backed session store, to avoid
// reintroducing the exact node-gyp/Python/Visual-Studio build hassle this
// project already went through once for better-sqlite3 — a contributor
// on Windows would hit that same wall again for a second native package
// otherwise.
if (!process.env.SESSION_SECRET) {
  // Not fatal on its own — refusing to boot over this would be a harsher
  // failure mode than the risk warrants, and could take a working site
  // down over a config gap discovered after the fact — but this MUST be
  // visible in the server's own logs, not just documentation, since the
  // fallback below is a fixed, publicly-readable string sitting directly
  // in this file: anyone who reads this codebase knows it, which means
  // session cookies signed with it aren't meaningfully protected against
  // forgery in a way that matters for a live, real-money site.
  console.warn(
    "[security] SESSION_SECRET is not set — falling back to a hardcoded " +
    "default that is visible to anyone who reads this codebase. Set a " +
    "real, random SESSION_SECRET in your environment before handling " +
    "real user sessions (e.g.: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\")."
  );
}

app.use(
  session({
    store: new FileStore({ path: path.join(DATA_DIR, "sessions"), logFn: () => {} }),
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
// Deliberately placed before the body parsers below, not after — found
// during testing that a malformed JSON body makes bodyParser.json() call
// next(err), which skips every remaining *normal* middleware (including
// this one) and jumps straight to the error handler at the bottom of this
// file. That error handler renders views/500.ejs, which includes the site
// header, which calls t(...) — undefined if this middleware never ran,
// crashing the error page itself and leaking a raw stack trace to the
// visitor instead of the intended generic message. Session only needs to
// run before this (res.locals.lang reads req.session), not after the body
// parsers, so moving both of these earlier fixes the root cause rather
// than patching around it in the error handler.
app.use((req, res, next) => {
  res.locals.isAdmin = !!(req.session && req.session.adminId);
  res.locals.isLoggedInLearner = !!(req.session && req.session.learnerId);
  res.locals.currencySymbol = require("./lib/currency").currencySymbol;
  res.locals.discounts = require("./lib/discounts");
  res.locals.courseFieldLimits = require("./lib/discounts").loadConfig().courseFieldLimits;
  res.locals.trainingModeShort = require("./lib/training-mode").trainingModeShort;
  res.locals.trainingModeCategory = require("./lib/training-mode").trainingModeCategory;
  res.locals.trainingModeSymbol = (mode) => require("./lib/training-mode").SYMBOLS[require("./lib/training-mode").trainingModeCategory(mode)];
  res.locals.lang = (req.session && req.session.lang) || "en";
  res.locals.t = require("./lib/i18n").translator(res.locals.lang);
  res.locals.currentPath = req.path;
  next();
});

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

app.use("/", require("./routes/public"));
app.use("/", require("./routes/registration"));
app.use("/", require("./routes/auth"));
app.use("/", require("./routes/onboarding"));
app.use("/", require("./routes/lms-teacher"));
app.use("/", require("./routes/lms-student"));
app.use("/", require("./routes/lms-content-delivery"));
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
// Awaited before the server starts accepting requests, so nobody can hit
// a certificate/badge download mid-regeneration — see the comment on
// backfillCertificates() in lib/certificates.js for why this exists.
require("./lib/certificates").backfillCertificates().finally(() => {
  const server = app.listen(PORT, () => {
    console.log(`Baseline Skills running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin/login`);
  });
  // LMS video uploads can be large (up to LMS_VIDEO_MAX_FILE_SIZE_MB,
  // currently 1GB) and take longer to fully arrive than Node's own
  // defaults allow for -- Node 18+'s server.requestTimeout defaults to 5
  // minutes for the whole request including its body, which a large file
  // on a modest upload connection can easily exceed, aborting the
  // request with no clear error ever reaching the browser ("save lesson
  // does not lead to anything" is exactly what that looks like from the
  // user's side). Raised well beyond what even a slow connection should
  // need for the largest allowed upload. This is Node's own server-level
  // timeout only -- a hosting platform's own reverse proxy/load balancer
  // (Render's, if that's where this runs) may enforce a separate,
  // shorter timeout in front of this server that isn't something this
  // application can configure from its own code.
  server.requestTimeout = 20 * 60 * 1000; // 20 minutes
  server.headersTimeout = 20 * 60 * 1000 + 5000; // must exceed requestTimeout
});
