// Simple in-memory rate limiter middleware to protect public forms and auth routes.

const stores = {};

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000; // 15 mins default
  const max = options.max || 10; // max requests per window
  const message = options.message || "Too many requests. Please try again later.";
  const keyPrefix = options.keyPrefix || "rl";

  // Periodically clean up old store entries every 5 mins
  setInterval(() => {
    const now = Date.now();
    Object.keys(stores).forEach((k) => {
      if (stores[k].resetTime < now) {
        delete stores[k];
      }
    });
  }, 5 * 60 * 1000).unref();

  return function rateLimiter(req, res, next) {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    if (!stores[key] || stores[key].resetTime < now) {
      stores[key] = { count: 1, resetTime: now + windowMs };
      return next();
    }

    stores[key].count += 1;

    if (stores[key].count > max) {
      res.setHeader("Retry-After", Math.ceil((stores[key].resetTime - now) / 1000));
      return res.status(429).send(`<!DOCTYPE html><html><head><title>Too Many Requests</title></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h2>429 Too Many Requests</h2><p>${message}</p><a href="javascript:history.back()">Go Back</a></body></html>`);
    }

    next();
  };
}

module.exports = createRateLimiter;
