const fs = require("fs");
const path = require("path");

// Unlike brochures (deliberately public marketing material), course
// materials must never be reachable through Express's static file
// middleware — Section 24 explicitly requires that private materials not
// be exposed via a publicly guessable URL. Stored outside public/ entirely,
// so the only way to reach a file is through the access-controlled download
// route, which checks the requester actually has a qualifying registration
// for that specific course before ever touching the filesystem.
const MATERIAL_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "materials")
  : path.join(__dirname, "..", "private-uploads", "materials");

fs.mkdirSync(MATERIAL_DIR, { recursive: true });

module.exports = { MATERIAL_DIR };
