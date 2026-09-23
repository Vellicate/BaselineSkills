const discounts = require("./discounts");

// The one server-side pricing calculation function (Part 10/28: "one
// pricing engine"), used identically by registration, checkout, the
// payment-provider amount, admin display, invoices/receipts, emails, and
// confirmation pages -- none of them are permitted to compute a price
// independently, and the browser is never the authority for any of these
// numbers (Part 9/13/23).
//
// basePriceCentsForMode resolves which price applies: a course's own
// per-delivery-mode row (course_delivery_options) if one exists, falling
// back to the course's original flat priceCents otherwise. This is what
// makes existing courses -- which have no delivery-option rows at all yet
// -- keep charging exactly what they always charged, for every mode,
// until an admin explicitly sets a mode-specific price (Part 24: backward
// compatibility, nothing existing breaks on deploy).
function basePriceCentsForMode(course, deliveryMode) {
  const option = (course.deliveryOptions || []).find((o) => o.deliveryMode === deliveryMode);
  if (option) return option.priceCents; // may be null (Corporate On-site/Private Cohort -- Part 4)
  return course.priceCents;
}

/**
 * The structured pricing result Part 10 specifies. All monetary fields
 * are integer cents; discountAmountCents and finalTotalCents are always
 * derived from baseTotalCents and discountPercent here, in this one
 * place, never recomputed differently elsewhere.
 *
 * Returns null baseRateCents/baseTotalCents/finalTotalCents when the mode
 * has no public price at all (Corporate On-site/Private Cohort) --
 * callers must check for this and route to the inquiry flow instead of
 * treating null as zero, which would mean "free."
 */
function calculatePricing({ course, deliveryMode, participantCount, sessionStartDate, couponCode }) {
  const count = Math.max(1, Math.floor(Number(participantCount) || 1));
  const baseRateCents = basePriceCentsForMode(course, deliveryMode);
  const currency = course.currency || "EUR";

  if (baseRateCents == null) {
    return {
      baseRateCents: null, participantCount: count, baseTotalCents: null,
      discountPercent: 0, discountAmountCents: null, finalTotalCents: null,
      currency, requiresInquiry: true,
    };
  }

  const baseTotalCents = baseRateCents * count;
  const discountPercent = discounts.effectiveDiscountPercent(course, sessionStartDate, couponCode, count);
  const discountAmountCents = Math.round(baseTotalCents * discountPercent / 100);
  const finalTotalCents = baseTotalCents - discountAmountCents;

  return {
    baseRateCents, participantCount: count, baseTotalCents,
    discountPercent, discountAmountCents, finalTotalCents,
    currency, requiresInquiry: false,
  };
}

module.exports = { calculatePricing, basePriceCentsForMode };
