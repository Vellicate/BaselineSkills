// Maps a currency code to its display symbol. Centralized here rather than
// hardcoding "$" throughout templates — which is exactly what happened
// originally and is why switching the platform default to EUR required
// finding every hardcoded dollar sign individually instead of changing one
// place. New currencies only need adding here, not hunting through views.
const SYMBOLS = { EUR: "€", USD: "$", GBP: "£" };

function currencySymbol(code) {
  return SYMBOLS[(code || "EUR").toUpperCase()] || (code ? code.toUpperCase() + " " : "€");
}

module.exports = { currencySymbol };
