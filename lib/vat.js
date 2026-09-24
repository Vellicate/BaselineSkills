const store = require("./db");

// VatService: the one place VAT is ever calculated. Rates come from the
// vat_rates table -- admin-editable without a deploy (Section 6), the
// exact reason this table exists in the schema already rather than a
// flat rate in business-rules.json. A country with no configured rate
// charges zero VAT rather than the request failing or silently assuming
// some default rate that may not apply to that country at all.
function vatRateForCountry(countryCode) {
  if (!countryCode) return 0;
  const row = store.findOne("vat_rates", (r) => r.countryCode === countryCode.toUpperCase());
  return row ? row.rate : 0;
}

// VAT is calculated on the taxable amount actually payable -- the group's
// discounted training total plus any certification exam fee -- matching
// standard practice of taxing the amount paid, not the pre-discount list
// price. Returns the rate actually applied (0 if this country has none
// configured) alongside the computed amount, so a caller can display
// "no VAT applicable" distinctly from "0% VAT" if it ever needs to.
function calculateVat(taxableAmountCents, countryCode) {
  const rate = vatRateForCountry(countryCode);
  const vatAmountCents = Math.round(taxableAmountCents * rate / 100);
  return { rate, vatAmountCents };
}

module.exports = { vatRateForCountry, calculateVat };
