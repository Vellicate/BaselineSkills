const store = require("./db");
const { loadConfig } = require("./discounts");

// The one place a course's applicable group-discount percent is ever
// calculated (Part 9: "implemented once in a server-side pricing service
// and reused by registration/checkout/payment/order summary/admin/
// invoices/emails/confirmation pages"). A course with its own explicit
// slab rows (course_group_discount_rules) uses those; a course with none
// falls back to the configured defaults (business-rules.json's
// GROUP_DISCOUNT_DEFAULT_SLABS) -- this is what makes "new courses default
// to X" and "existing courses also receive these defaults" simultaneously
// true without ever writing default rows into every course: the fallback
// naturally applies to any course, new or old, that has no override, and
// a course with explicit rows is never touched or overwritten by it.
function slabsForCourse(course) {
  if (course.groupDiscountRules && course.groupDiscountRules.length > 0) {
    return course.groupDiscountRules.map((r) => ({ min: r.minParticipants, max: r.maxParticipants, percent: r.discountPercent }));
  }
  return loadConfig().discounts.GROUP_DISCOUNT_DEFAULT_SLABS;
}

// Returns the discount percent for exactly this many participants, 0 if
// none of the course's slabs cover this count (including 1-2 participants
// against the default slabs, which start at 3 -- Part 7's explicit
// "1-2 = 0%" falls out of this naturally, not as a special case).
function groupDiscountPercent(course, participantCount) {
  if (!Number.isFinite(participantCount) || participantCount < 1) return 0;
  const slabs = slabsForCourse(course);
  const match = slabs.find((s) => participantCount >= s.min && (s.max == null || participantCount <= s.max));
  return match ? match.percent : 0;
}

module.exports = { slabsForCourse, groupDiscountPercent };
