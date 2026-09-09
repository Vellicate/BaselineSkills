// Lightweight, in-memory security middleware for this single-process app.
// No external dependencies — a Map keyed by client IP is enough for the
// threat model here (opportunistic brute-forcing / form spam / CSRF from a
// third-party page), and avoids pulling in extra packages for a small site.
// Note the tradeoff: state is per-process and resets on restart/deploy, and
// doesn't share state across multiple instances. Fine for a single-instance
// deployment; swap for a shared store (e.g. Redis-backed limiter) if this
// ever runs behind a load balancer with more than one process.

function clientIp(req) {
  // Trust X-Forwarded-For only if you've explicitly configured
  // `app.set("trust proxy", ...)` for your actual deployment (e.g. behind
  // Netlify/Heroku/nginx). Falling back to req.ip either way.
  return req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
}

/**
 * Generic per-IP rate limiter: allows `max` requests per `windowMs`,
 * counting every request that reaches this middleware (success or failure).
 * Suitable for public form endpoints (contact, inquiry, registration).
 */
function createIpRateLimiter({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 5 * 60 * 1000)).unref();

  return function rateLimit(req, res, next) {
    const key = clientIp(req);
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.set("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).send(message || "Too many requests. Please try again later.");
    }

    next();
  };
}

/**
 * Login-specific limiter: counts only *failed* attempts per IP (a
 * successful login clears the count), since penalizing successful logins
 * the same as failed guesses would lock out legitimate admins too easily.
 * Usage: call `check(req)` before verifying the password; if it returns
 * `{ blocked: true }`, reject immediately. Otherwise verify the password,
 * then call `recordFailure(req)` or `recordSuccess(req)` based on the
 * outcome.
 */
function createLoginAttemptTracker({ windowMs, maxAttempts }) {
  const attempts = new Map(); // ip -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(key);
    }
  }, Math.min(windowMs, 5 * 60 * 1000)).unref();

  function check(req) {
    const key = clientIp(req);
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) return { blocked: false };
    if (entry.count >= maxAttempts) {
      return { blocked: true, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { blocked: false };
  }

  function recordFailure(req) {
    const key = clientIp(req);
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      attempts.set(key, entry);
    }
    entry.count += 1;
  }

  function recordSuccess(req) {
    attempts.delete(clientIp(req));
  }

  return { check, recordFailure, recordSuccess };
}

/**
 * CSRF defense for state-changing (POST/PUT/PATCH/DELETE) requests.
 *
 * This app doesn't currently issue per-form CSRF tokens, so as a first line
 * of defense this validates that the request's Origin (falling back to
 * Referer) header matches this server's own host — a cross-site form or
 * link submitting to these endpoints won't have a matching Origin. This is
 * the same mechanism SameSite=Lax cookies already provide for top-level
 * navigations, so this middleware mainly closes the gap for non-navigation
 * cross-origin POSTs (e.g. fetch() with credentials from another origin,
 * or an auto-submitting form loaded in a background frame).
 *
 * For stronger, defense-in-depth CSRF protection, consider adding real
 * per-session anti-CSRF tokens (double-submit cookie or a `csrf-csrf`-style
 * package) in addition to this check.
 */
function requireSameOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();

  const origin = req.get("origin");
  const referer = req.get("referer");
  const host = req.get("host");

  if (!host) return res.status(400).send("Missing Host header.");

  const candidate = origin || referer;
  if (!candidate) {
    // No Origin and no Referer at all is unusual for a browser form submit,
    // but some privacy tools strip both. Rather than silently allow it,
    // fail closed — legitimate admin UI always sends at least one.
    return res.status(403).send("Request rejected: missing Origin/Referer header.");
  }

  let candidateHost;
  try {
    candidateHost = new URL(candidate).host;
  } catch (e) {
    return res.status(403).send("Request rejected: malformed Origin/Referer header.");
  }

  if (candidateHost !== host) {
    console.warn(`[csrf] rejected cross-origin request to ${req.originalUrl} (Origin/Referer host: ${candidateHost}, expected: ${host})`);
    return res.status(403).send("Request rejected: cross-origin request not allowed.");
  }

  next();
}

module.exports = { createIpRateLimiter, createLoginAttemptTracker, requireSameOrigin, clientIp };
