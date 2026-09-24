// A reasonably complete ISO 3166-1 alpha-2 country list, purpose-built for
// the registration form's country selector -- the value submitted must be
// the 2-letter code, since that's what vat_rates.countryCode matches
// against exactly (lib/vat.js). A free-text country field, like the one
// on the learner signup form, could never reliably match a VAT rate row.
const COUNTRIES = [
  ["AT", "Austria"], ["AU", "Australia"], ["BE", "Belgium"], ["BG", "Bulgaria"],
  ["BR", "Brazil"], ["CA", "Canada"], ["CH", "Switzerland"], ["CN", "China"],
  ["CY", "Cyprus"], ["CZ", "Czech Republic"], ["DE", "Germany"], ["DK", "Denmark"],
  ["EE", "Estonia"], ["ES", "Spain"], ["FI", "Finland"], ["FR", "France"],
  ["GB", "United Kingdom"], ["GR", "Greece"], ["HR", "Croatia"], ["HU", "Hungary"],
  ["IE", "Ireland"], ["IN", "India"], ["IT", "Italy"], ["JP", "Japan"],
  ["LT", "Lithuania"], ["LU", "Luxembourg"], ["LV", "Latvia"], ["MT", "Malta"],
  ["MX", "Mexico"], ["NL", "Netherlands"], ["NO", "Norway"], ["NZ", "New Zealand"],
  ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["SE", "Sweden"],
  ["SG", "Singapore"], ["SI", "Slovenia"], ["SK", "Slovakia"], ["US", "United States"],
  ["ZA", "South Africa"], ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"],
];

module.exports = { COUNTRIES };
