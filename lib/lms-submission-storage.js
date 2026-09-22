const fs = require("fs");
const path = require("path");

// Same DATA_DIR-relative convention as lib/lms-content-storage.js and
// every other upload type in this codebase -- kept as its own directory
// rather than reusing lms-content-storage's, since these files are
// student-authored submissions, not teacher-authored lesson content, and
// the two have different lifecycles/ownership even though the storage
// mechanics are identical.
const LMS_SUBMISSION_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "lms-submissions")
  : path.join(__dirname, "..", "public", "uploads", "lms-submissions");

fs.mkdirSync(LMS_SUBMISSION_DIR, { recursive: true });

module.exports = { LMS_SUBMISSION_DIR };
