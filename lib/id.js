const crypto = require("crypto");

function newId(prefix) {
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${Date.now()}_${rand}`;
}

module.exports = { newId };
