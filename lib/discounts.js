// Early-bird discount calculation — reads every threshold and percentage
// from config/business-rules.json (Master Prompt Section 6). No literal 60,
// 30, or discount percentage appears anywhere in this file; change the
// config and behavior changes with no code edit.
const fs = require("fs");
const path = require("path");
const store = require("./db");

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
 * Whether a single course_discounts row is applicable right now, given the
 * session it would apply to. Semantics as specified: a blank startDate
 * means "applicable immediately" (no lower bound); a blank endDate means
 * "does not expire until the start of the training" — i.e. valid up until
 * the session's own start date, not indefinitely. sessionStartDate values
 * that aren't real dates (e.g. "On Demand") are treated as having no
 * session-based upper bound, since there's no session start to expire
 * against.
 */
function isDiscountApplicable(discount, sessionStartDate) {
  const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());

  if (discount.startDate) {
    const start = new Date(discount.startDate + "T00:00:00Z");
    if (!Number.isNaN(start.getTime()) && todayUtc < start.getTime()) return false;
  }

  if (discount.endDate) {
    const end = new Date(discount.endDate + "T00:00:00Z");
    if (!Number.isNaN(end.getTime()) && todayUtc > end.getTime()) return false;
  } else if (sessionStartDate) {
    const sessionStart = new Date(sessionStartDate + "T00:00:00Z");
    if (!Number.isNaN(sessionStart.getTime()) && todayUtc > sessionStart.getTime()) return false;
  }

  return true;
}

/**
 * The best (highest-percent) currently-applicable course_discounts row for
 * this course and session — not every discount that exists on the course,
 * only ones whose date window is active right now. Returns 0 if none apply.
 */
function bestApplicableCourseDiscountPercent(courseId, sessionStartDate) {
  const discounts = store.readAll("course_discounts").filter((d) => d.courseId === courseId);
  const applicable = discounts.filter((d) => isDiscountApplicable(d, sessionStartDate));
  if (!applicable.length) return 0;
  return Math.max(...applicable.map((d) => d.percent));
}

/**
 * Validates a coupon code against a specific course and session. A coupon
 * with no courseId is valid for any course (a sitewide code); one with a
 * courseId only validates against that exact course. Returns
 * { valid: true, percent } or { valid: false, reason }.
 */
function validateCouponCode(code, courseId, sessionStartDate) {
  if (!code) return { valid: false, reason: "No coupon code provided." };
  const coupon = store.findOne("coupon_codes", (c) => c.code.toLowerCase() === code.trim().toLowerCase());
  if (!coupon) return { valid: false, reason: "That coupon code doesn't exist." };
  if (!coupon.active) return { valid: false, reason: "That coupon code is no longer active." };
  if (coupon.courseId && coupon.courseId !== courseId) return { valid: false, reason: "That coupon code doesn't apply to this course." };
  if (!isDiscountApplicable(coupon, sessionStartDate)) return { valid: false, reason: "That coupon code isn't valid right now — check its start and end dates." };
  return { valid: true, percent: coupon.percent, couponId: coupon.id };
}

/**
 * Combines the course's applicable time-bounded discounts (see
 * course_discounts) with the calculated early-bird rate for this session —
 * takes the larger of the two rather than stacking them, capped at
 * MAX_COMBINED_DISCOUNT_PERCENT, matching the discount policy already
 * documented in the Pricing & Commissions work. An optional coupon code,
 * if valid, is compared the same way — the best of all three, never
 * stacked, still capped.
 */
function effectiveDiscountPercent(course, sessionStartDate, couponCode) {
  const cfg = loadConfig().discounts;
  const earlyBird = earlyBirdForSession(sessionStartDate);
  const courseDiscount = bestApplicableCourseDiscountPercent(course.id, sessionStartDate);
  let combined = Math.max(courseDiscount, earlyBird.percent);
  if (couponCode) {
    const validation = validateCouponCode(couponCode, course.id, sessionStartDate);
    if (validation.valid) combined = Math.max(combined, validation.percent);
  }
  return Math.min(combined, cfg.MAX_COMBINED_DISCOUNT_PERCENT);
}

function finalPriceCentsForSession(course, sessionStartDate, couponCode) {
  const discount = effectiveDiscountPercent(course, sessionStartDate, couponCode);
  return Math.round(course.priceCents * (1 - discount / 100));
}

module.exports = { loadConfig, daysUntil, earlyBirdForSession, effectiveDiscountPercent, finalPriceCentsForSession, isDiscountApplicable, bestApplicableCourseDiscountPercent, validateCouponCode };
