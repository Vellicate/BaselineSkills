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
// reasonKey, not a user-facing reason string -- this module has no access
// to the request's language. Each call site in routes/registration.js
// translates it via t('coupon_reason_' + reasonKey) at the point where the
// result actually reaches a template or JSON response, since that's where
// t() (bound to this specific request's language) is available.
function validateCouponCode(code, courseId, sessionStartDate) {
  if (!code) return { valid: false, reasonKey: "no_code_provided" };
  const coupon = store.findOne("coupon_codes", (c) => c.code.toLowerCase() === code.trim().toLowerCase());
  if (!coupon) return { valid: false, reasonKey: "code_not_found" };
  if (!coupon.active) return { valid: false, reasonKey: "code_inactive" };
  if (coupon.courseId && coupon.courseId !== courseId) return { valid: false, reasonKey: "code_wrong_course" };
  if (!isDiscountApplicable(coupon, sessionStartDate)) return { valid: false, reasonKey: "code_date_invalid" };
  return { valid: true, percent: coupon.percent, couponId: coupon.id };
}

/**
 * Combines the course's applicable time-bounded discounts (see
 * course_discounts) with the calculated early-bird rate for this session,
 * and the group-registration discount for this participant count --
 * takes the largest of these three automatic discounts rather than
 * stacking, capped at MAX_COMBINED_DISCOUNT_PERCENT, matching the discount
 * policy already documented in the Pricing & Commissions work.
 *
 * An optional coupon code is compared against that capped automatic
 * total the same way — the larger of the two wins, never stacked — but
 * the coupon's own percent is never itself reduced by the cap. A coupon
 * is a specific number an admin deliberately typed in when creating it
 * (see the admin coupon form, which allows 1-100%), unlike the three
 * automatic discounts above, which combine independent rules that were
 * never vetted against each other and so need a shared ceiling. Found
 * necessary when a coupon meant to give 50% off was silently landing at
 * 25% with no warning anywhere an admin would see it, since the original
 * version of this function capped the coupon along with everything else.
 *
 * participantCount defaults to 1, under which groupDiscountPercent always
 * returns 0 (Part 7's "1-2 participants = 0%") — every existing call site
 * that doesn't pass this argument at all behaves exactly as it did before
 * group discounts existed.
 */
function effectiveDiscountPercent(course, sessionStartDate, couponCode, participantCount = 1) {
  const cfg = loadConfig().discounts;
  const earlyBird = earlyBirdForSession(sessionStartDate);
  const courseDiscount = bestApplicableCourseDiscountPercent(course.id, sessionStartDate);
  const groupDiscount = require("./group-discount").groupDiscountPercent(course, participantCount);
  const cappedAutomatic = Math.min(Math.max(courseDiscount, earlyBird.percent, groupDiscount), cfg.MAX_COMBINED_DISCOUNT_PERCENT);
  if (!couponCode) return cappedAutomatic;
  const validation = validateCouponCode(couponCode, course.id, sessionStartDate);
  if (!validation.valid) return cappedAutomatic;
  return Math.max(cappedAutomatic, validation.percent);
}

function finalPriceCentsForSession(course, sessionStartDate, couponCode, participantCount = 1) {
  const discount = effectiveDiscountPercent(course, sessionStartDate, couponCode, participantCount);
  return Math.round(course.priceCents * (1 - discount / 100));
}

module.exports = { loadConfig, daysUntil, earlyBirdForSession, effectiveDiscountPercent, finalPriceCentsForSession, isDiscountApplicable, bestApplicableCourseDiscountPercent, validateCouponCode };
