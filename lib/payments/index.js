// Provider-agnostic payment interface — routes.registration.js never needs
// to know whether a given registration is paying via Paddle or PayPal.
// Adding a third provider later means adding one file here and one entry
// in PROVIDERS, not touching the registration flow itself.

const paddle = require("./paddle");
const paypal = require("./paypal");

const PROVIDERS = { paddle, paypal };

function isValidProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name);
}

function isConfigured(providerName) {
  if (!isValidProvider(providerName)) return false;
  return PROVIDERS[providerName].isConfigured();
}

// Which providers are actually usable right now — drives what the checkout
// UI offers. A provider only appears if its own credentials are set.
function availableProviders() {
  return Object.keys(PROVIDERS).filter((name) => PROVIDERS[name].isConfigured());
}

async function createOrder(providerName, { course, registration }) {
  if (!isValidProvider(providerName)) throw new Error(`Unknown payment provider: ${providerName}`);
  return PROVIDERS[providerName].createOrder({ course, registration });
}

// Not every provider implements this yet (Paddle doesn't, as of writing) —
// reports { supported: false } rather than throwing, so a caller can
// treat "can't check" the same safe way it already treats "checked, and
// it wasn't captured": proceed with a new order, rather than blocking the
// customer on a capability that simply doesn't exist for their provider.
async function getOrderStatus(providerName, orderId) {
  if (!isValidProvider(providerName) || typeof PROVIDERS[providerName].getOrderStatus !== "function") {
    return { supported: false, captured: false };
  }
  const result = await PROVIDERS[providerName].getOrderStatus(orderId);
  return { supported: true, ...result };
}

function getClientConfig(providerName) {
  if (!isValidProvider(providerName)) return null;
  return PROVIDERS[providerName].getClientConfig();
}

module.exports = { isValidProvider, isConfigured, availableProviders, createOrder, getOrderStatus, getClientConfig, paddle, paypal };
