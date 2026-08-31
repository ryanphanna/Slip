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
  const merchant = normalizeMerchant(raw.merchant);
  const type = VALID_TYPES.includes(raw.type) ? raw.type : 'purchase';
  // Convention: refund amounts are always stored negative (money back reduces
  // spend), regardless of how the sign was printed on the receipt/parsed by
  // Gemini. This keeps sum-based spending totals correct without every
  // caller having to special-case type === 'refund'.
  const sign = type === 'refund' ? -1 : 1;
  const signed = (val) => {
    const n = toNumber(val);
    return n == null ? null : sign * Math.abs(n);
  };

  return {
    merchant,

    location: typeof raw.location === 'string' && !['undefined', 'null'].includes(raw.location.trim().toLowerCase())
      ? raw.location.trim()
      : null,
    date: isValidDate(raw.date) ? raw.date : null,
    total: signed(raw.total),
    subtotal: signed(raw.subtotal),
    tax: signed(raw.tax),
    category: VALID_CATEGORIES.includes(raw.category) ? raw.category : 'Other',
    subCategory: typeof raw.subCategory === 'string' ? raw.subCategory.trim() : null,
    items: Array.isArray(raw.items)
      ? raw.items
          .filter(i => i && typeof i.name === 'string')
          .map(i => ({
            name: i.name.trim(),
            price: signed(i.price),
            quantity: Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : 1,
            category: VALID_CATEGORIES.includes(i.category) ? i.category : (VALID_CATEGORIES.includes(raw.category) ? raw.category : 'Other'),
            ...(i.verified === true ? { verified: true } : {}),
            ...(typeof i.publicName === 'string' && i.publicName.trim() ? { publicName: i.publicName.trim() } : {}),
            ...(typeof i.itemNumber === 'string' && i.itemNumber.trim()
              ? { itemNumber: i.itemNumber.trim() }
              : (merchant === 'IKEA' && extractIkeaItemNumber(i.name) ? { itemNumber: extractIkeaItemNumber(i.name) } : {})),
            ...(typeof i.productUrl === 'string' && i.productUrl.trim() ? { productUrl: i.productUrl.trim() } : {}),
          }))
      : [],
    currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : 'CAD',
    type,
    isSubscription: typeof raw.isSubscription === 'boolean' ? raw.isSubscription : false,
    loyaltyPointsEarned: toNumber(raw.loyaltyPointsEarned),
    loyaltyPointsBalance: toNumber(raw.loyaltyPointsBalance),
  };
}

// IKEA receipt lines commonly include the article number in the OCR name, but
// Gemini may omit the separate structured field. Only infer the canonical
// eight-digit form; shorter OCR fragments are too risky to publish as IDs.
function extractIkeaItemNumber(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(/(?:article\s+)?(\d{3}[.\s]?\d{3}[.\s]?\d{2})\b/i);
  return match ? match[1].replace(/[.\s]/g, '') : null;
}

function isValidDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

function toNumber(val) {
  const n = parseFloat(val);
  // Allow negative numbers so refunds can have negative totals/items
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

module.exports = { validateReceipt, normalizeMerchant, extractIkeaItemNumber };
