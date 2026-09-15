const fs = require("fs");
const path = require("path");

// Same DATA_DIR-relative convention as lib/brochures.js — lands on the
// persistent disk in production, not the ephemeral container filesystem.
const COURSE_OUTLINE_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "course-outlines")
  : path.join(__dirname, "..", "public", "uploads", "course-outlines");

fs.mkdirSync(COURSE_OUTLINE_DIR, { recursive: true });

module.exports = { COURSE_OUTLINE_DIR };
