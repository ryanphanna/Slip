const config = require('./config');

const VALID_CATEGORIES = ['Takeout/Dining', 'Grocery', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Home', 'Other'];
const VALID_TYPES = ['purchase', 'refund'];

function normalizeMerchant(name) {
  if (typeof name !== 'string') return null;
  const clean = name.trim();
  const lower = clean.toLowerCase();

  // Try direct lookup in the normalization map
  if (config.MERCHANT_NORMALIZE_MAP && config.MERCHANT_NORMALIZE_MAP[lower]) {
    return config.MERCHANT_NORMALIZE_MAP[lower];
  }

  // Try substring checks for safety (e.g. "Walmart Supercenter" -> "Walmart")
  for (const [key, canonical] of Object.entries(config.MERCHANT_NORMALIZE_MAP || {})) {
    if (lower.includes(key)) {
      return canonical;
    }
  }

  return clean;
}

// Clean and validate the parsed receipt object before writing to Firestore.
function validateReceipt(raw) {
  return {
    merchant: normalizeMerchant(raw.merchant),

    location: typeof raw.location === 'string' ? raw.location.trim() : null,
    date: isValidDate(raw.date) ? raw.date : null,
    total: toNumber(raw.total),
    subtotal: toNumber(raw.subtotal),
    tax: toNumber(raw.tax),
    category: VALID_CATEGORIES.includes(raw.category) ? raw.category : 'Other',
    subCategory: typeof raw.subCategory === 'string' ? raw.subCategory.trim() : null,
    items: Array.isArray(raw.items)
      ? raw.items
          .filter(i => i && typeof i.name === 'string')
          .map(i => ({
            name: i.name.trim(),
            price: toNumber(i.price),
            category: VALID_CATEGORIES.includes(i.category) ? i.category : (VALID_CATEGORIES.includes(raw.category) ? raw.category : 'Other'),
          }))
      : [],
    currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : 'CAD',
    type: VALID_TYPES.includes(raw.type) ? raw.type : 'purchase',
    isSubscription: typeof raw.isSubscription === 'boolean' ? raw.isSubscription : false,
    loyaltyPointsEarned: toNumber(raw.loyaltyPointsEarned),
    loyaltyPointsBalance: toNumber(raw.loyaltyPointsBalance),
  };
}

function isValidDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

function toNumber(val) {
  const n = parseFloat(val);
  // Allow negative numbers so refunds can have negative totals/items
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

module.exports = { validateReceipt };
