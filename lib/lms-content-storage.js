const fs = require("fs");
const path = require("path");

// Same DATA_DIR-relative convention as lib/course-outlines.js, lib/brochures.js
// etc. -- lands on the persistent disk in production, not the ephemeral
// container filesystem, and (critically for this one) is NOT under
// public/ in production, so express.static never serves these files
// directly. Every access must go through the protected route in
// routes/lms-teacher.js / routes/lms-student.js, which checks
// LmsContentAccessService before ever touching this directory.
const LMS_CONTENT_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "lms-content")
  : path.join(__dirname, "..", "public", "uploads", "lms-content");

fs.mkdirSync(LMS_CONTENT_DIR, { recursive: true });

module.exports = { LMS_CONTENT_DIR };
