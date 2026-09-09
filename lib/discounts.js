// Early-bird discount calculation — reads every threshold and percentage
// from config/business-rules.json (Master Prompt Section 6). No literal 60,
// 30, or discount percentage appears anywhere in this file; change the
// config and behavior changes with no code edit.
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "business-rules.json");

function loadConfig() {
  // Re-read on every call rather than caching at module-load time, so a
  // config change takes effect without restarting the process — matching
  // Section 6's goal that a business administrator can change these values
  // without a code change (a restart is a much lower bar to clear than that).
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + "T00:00:00Z");
  if (Number.isNaN(target.getTime())) return null; // e.g. "On Demand" — not a real date
  const now = new Date();
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((target.getTime() - nowUtc) / (1000 * 60 * 60 * 24));
}

/**
 * Returns { percent, tierLabel, daysUntilSession, deadlineDate, daysUntilDeadline }
 * for the early-bird tier that applies to a session starting on sessionStartDate,
 * evaluated against the current date.
 */
function earlyBirdForSession(sessionStartDate) {
  const cfg = loadConfig().discounts;
  const days = daysUntil(sessionStartDate);

  if (days === null) {
    return { percent: 0, tierLabel: null, daysUntilSession: null, deadlineDate: null, daysUntilDeadline: null };
  }

  if (days >= cfg.EARLY_BIRD_1_DAYS) {
    const deadline = new Date(sessionStartDate + "T00:00:00Z");
    deadline.setUTCDate(deadline.getUTCDate() - cfg.EARLY_BIRD_1_DAYS);
    return {
      percent: cfg.EARLY_BIRD_1_DISCOUNT_PERCENT, tierLabel: "Very Early Bird",
      daysUntilSession: days, deadlineDate: deadline.toISOString().slice(0, 10),
      daysUntilDeadline: daysUntil(deadline.toISOString().slice(0, 10)),
    };
  }
  if (days >= cfg.EARLY_BIRD_2_DAYS) {
    const deadline = new Date(sessionStartDate + "T00:00:00Z");
    deadline.setUTCDate(deadline.getUTCDate() - cfg.EARLY_BIRD_2_DAYS);
    return {
      percent: cfg.EARLY_BIRD_2_DISCOUNT_PERCENT, tierLabel: "Early Bird",
      daysUntilSession: days, deadlineDate: deadline.toISOString().slice(0, 10),
      daysUntilDeadline: daysUntil(deadline.toISOString().slice(0, 10)),
    };
  }
  return { percent: 0, tierLabel: "Standard", daysUntilSession: days, deadlineDate: null, daysUntilDeadline: null };
}

/**
 * Combines the course's own flat discountPercent (an admin-set promotional
 * rate) with the calculated early-bird rate for this session — takes the
 * larger of the two rather than stacking them, capped at
 * MAX_COMBINED_DISCOUNT_PERCENT, matching the discount policy already
 * documented in the Pricing & Commissions work.
 */
function effectiveDiscountPercent(course, sessionStartDate) {
  const cfg = loadConfig().discounts;
  const earlyBird = earlyBirdForSession(sessionStartDate);
  const flat = course.discountPercent || 0;
  const combined = Math.max(flat, earlyBird.percent);
  return Math.min(combined, cfg.MAX_COMBINED_DISCOUNT_PERCENT);
}

function finalPriceCentsForSession(course, sessionStartDate) {
  const discount = effectiveDiscountPercent(course, sessionStartDate);
  return Math.round(course.priceCents * (1 - discount / 100));
}

module.exports = { loadConfig, daysUntil, earlyBirdForSession, effectiveDiscountPercent, finalPriceCentsForSession };
