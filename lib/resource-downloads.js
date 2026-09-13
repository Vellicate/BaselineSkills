const fs = require("fs");
const path = require("path");

// Same DATA_DIR-relative convention as lib/brochures.js — lands on the
// persistent disk in production, not the ephemeral container filesystem,
// and keeps the admin upload route and public download route agreeing on
// exactly where these files live.
const RESOURCE_DOWNLOAD_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "resource-downloads")
  : path.join(__dirname, "..", "public", "uploads", "resource-downloads");

fs.mkdirSync(RESOURCE_DOWNLOAD_DIR, { recursive: true });

module.exports = { RESOURCE_DOWNLOAD_DIR };
