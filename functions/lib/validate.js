const VALID_CATEGORIES = ['Food', 'Grocery', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Other'];
const VALID_TYPES = ['purchase', 'refund'];

// Clean and validate the parsed receipt object before writing to Firestore.
function validateReceipt(raw) {
  return {
    merchant: typeof raw.merchant === 'string' ? raw.merchant.trim() : null,
    location: typeof raw.location === 'string' ? raw.location.trim() : null,
    date: isValidDate(raw.date) ? raw.date : null,
    total: toNumber(raw.total),
    subtotal: toNumber(raw.subtotal),
    tax: toNumber(raw.tax),
    category: VALID_CATEGORIES.includes(raw.category) ? raw.category : 'Other',
    items: Array.isArray(raw.items)
      ? raw.items
          .filter(i => i && typeof i.name === 'string')
          .map(i => ({ name: i.name.trim(), price: toNumber(i.price) }))
      : [],
    currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : 'CAD',
    type: VALID_TYPES.includes(raw.type) ? raw.type : 'purchase',
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
