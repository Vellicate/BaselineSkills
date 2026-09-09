// Commission calculation (Master Prompt Section 27/28). Every rate comes
// from config/business-rules.json — no literal 60, 80, 70, 10, or 15
// appears anywhere in this file. Computed on the course portion of a sale
// only, not the certification exam fee — the exam fee is a pass-through
// to the certifying body, not revenue this platform or its instructors
// actually earn a share of.
const store = require("./db");
const discounts = require("./discounts");

/**
 * Determines which commission rule applies to a registration and returns
 * a fully itemized breakdown — every field named in Section 28 (gross,
 * discount, exam fee, commission, net) rather than just a final number,
 * so the result is genuinely auditable line by line, not a black box.
 */
function calculateCommission(registration) {
  const cfg = discounts.loadConfig().commissions;
  const course = store.findOne("courses", (c) => c.id === registration.courseId);

  const examFeeCents = registration.examPriceCentsCharged || 0;
  const courseRevenueCents = registration.priceCentsCharged - examFeeCents;
  const originalCourseFee = course ? course.priceCents : courseRevenueCents;
  const discountCents = Math.max(0, originalCourseFee - courseRevenueCents);

  let recipientType = null;
  let recipientId = null;
  let ratePercent = 0;
  let tier = "none";

  if (registration.referralType === "instructor" && registration.referredById) {
    // An instructor referred this sale via their own code — courseScope on
    // that code is always their own course by construction (see
    // referral_codes design notes), so this is always the "referred" tier,
    // not "platform-sourced," regardless of which course it's for.
    recipientType = "instructor";
    recipientId = registration.referredById;
    ratePercent = cfg.INSTRUCTOR_REFERRED_PERCENT;
    tier = "instructor_referred";
  } else if (registration.referralType === "affiliate" && registration.referredById) {
    recipientType = "affiliate";
    recipientId = registration.referredById;
    // Tiered by this affiliate's own trailing-quarter referred revenue —
    // not a flat rate regardless of volume.
    const quarterlyRevenue = affiliateQuarterlyRevenueCents(registration.referredById, registration.createdAt);
    ratePercent = quarterlyRevenue >= cfg.AFFILIATE_HIGH_TIER_QUARTERLY_REVENUE_THRESHOLD_CENTS
      ? cfg.AFFILIATE_HIGH_TIER_PERCENT
      : cfg.AFFILIATE_STANDARD_PERCENT;
    tier = "affiliate";
  } else if (course && course.trainerId) {
    // No referral at all — the platform sourced this sale itself. The
    // course's own instructor still earns the platform-sourced rate for
    // having taught it.
    recipientType = "instructor";
    recipientId = course.trainerId;
    ratePercent = cfg.INSTRUCTOR_PLATFORM_SOURCED_PERCENT;
    tier = "platform_sourced";
  }
  // Corporate/bulk (INSTRUCTOR_CORPORATE_BULK_PERCENT) is not yet reachable
  // here — it requires real corporate-account attribution on a
  // registration, which doesn't exist anywhere in this app yet (no
  // corporate purchase flow has been built). Deliberately not guessed at
  // via a proxy signal like "company field is non-empty," since that would
  // silently misclassify an individual who simply entered their employer's
  // name at checkout.

  const commissionCents = recipientType ? Math.round(courseRevenueCents * (ratePercent / 100)) : 0;
  const netPayableCents = commissionCents;

  return {
    registrationId: registration.id,
    tier,
    recipientType, recipientId, ratePercent,
    grossCourseRevenueCents: courseRevenueCents,
    discountCents,
    examFeeCents,
    // Taxes, withholding, and gateway charges are named explicitly rather
    // than silently omitted — none of these are calculated anywhere in
    // this app yet (no VAT engine, no gateway-fee reporting from Paddle/
    // PayPal, no withholding-tax configuration), so each is shown as an
    // honest zero/unknown rather than folded invisibly into the net figure.
    taxesCents: 0,
    withholdingCents: 0,
    gatewayChargeCents: 0,
    commissionCents,
    netPayableCents,
  };
}

function affiliateQuarterlyRevenueCents(affiliateId, asOfDateIso) {
  const asOf = new Date(asOfDateIso);
  const quarterStart = new Date(asOf.getFullYear(), Math.floor(asOf.getMonth() / 3) * 3, 1);
  return store.readAll("registrations")
    .filter((r) => r.referralType === "affiliate" && r.referredById === affiliateId && new Date(r.createdAt) >= quarterStart && new Date(r.createdAt) <= asOf)
    .reduce((sum, r) => sum + (r.priceCentsCharged - (r.examPriceCentsCharged || 0)), 0);
}

module.exports = { calculateCommission, affiliateQuarterlyRevenueCents };
