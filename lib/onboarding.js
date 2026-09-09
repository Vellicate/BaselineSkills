const fs = require("fs");
const path = require("path");

// Signed RoE uploads — same DATA_DIR-relative convention as every other
// upload type in this app, so they survive redeploys. Kept private (like
// course materials, unlike brochures) since a signed agreement containing
// someone's real signature/details shouldn't be reachable via a guessable
// public URL — only the admin approval flow needs to read these.
const ROE_UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "roe-uploads")
  : path.join(__dirname, "..", "private-uploads", "roe");

fs.mkdirSync(ROE_UPLOAD_DIR, { recursive: true });

module.exports = { ROE_UPLOAD_DIR };
