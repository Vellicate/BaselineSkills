const fs = require("fs");
const path = require("path");

// Same DATA_DIR-relative convention as lib/brochures.js — lands on the
// persistent disk in production, not the ephemeral container filesystem,
// and both the admin upload route and the public serving route share
// this one definition so they can never disagree on where these files
// actually live.
const TRAINER_PHOTO_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "trainer-photos")
  : path.join(__dirname, "..", "public", "uploads", "trainer-photos");

fs.mkdirSync(TRAINER_PHOTO_DIR, { recursive: true });

module.exports = { TRAINER_PHOTO_DIR };
