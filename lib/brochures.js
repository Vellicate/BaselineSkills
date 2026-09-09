const fs = require("fs");
const path = require("path");

// Brochure PDFs are stored outside the app's code path so they survive
// redeploys the same way /data does — same DATA_DIR-relative convention
// used by lib/store.js, so this also lands on the persistent disk in
// production rather than the ephemeral container filesystem. Kept in one
// shared place so the admin upload route and the public download route
// can never disagree on where these files actually live.
const BROCHURE_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "brochures")
  : path.join(__dirname, "..", "public", "uploads", "brochures");

fs.mkdirSync(BROCHURE_DIR, { recursive: true });

module.exports = { BROCHURE_DIR };
