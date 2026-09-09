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

function getClientConfig(providerName) {
  if (!isValidProvider(providerName)) return null;
  return PROVIDERS[providerName].getClientConfig();
}

module.exports = { isValidProvider, isConfigured, availableProviders, createOrder, getClientConfig, paddle, paypal };
