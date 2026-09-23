const fs = require("fs");
const path = require("path");

// Same DATA_DIR-relative convention as lib/course-outlines.js, lib/brochures.js
// etc. -- lands on the persistent disk in production, not the ephemeral
// container filesystem. The local (no-DATA_DIR) fallback matches
// lib/materials.js's private-uploads/ convention, not public/uploads/ --
// found via a real security-review test that a raw request to the old
// public/uploads/lms-content path returned this file directly, completely
// bypassing every enrollment/date-window/preview check the protected
// route enforces. The DATA_DIR branch was never reachable this way (it
// was never under public/ in production), but the local fallback
// contradicted this file's own stated intent whenever DATA_DIR isn't
// set, which is exactly the environment this was actually tested in.
// Every access must go through the protected route in
// routes/lms-teacher.js / routes/lms-student.js, which checks
// LmsContentAccessService before ever touching this directory.
const LMS_CONTENT_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "lms-content")
  : path.join(__dirname, "..", "private-uploads", "lms-content");

fs.mkdirSync(LMS_CONTENT_DIR, { recursive: true });

module.exports = { LMS_CONTENT_DIR };
