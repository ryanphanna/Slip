const VALID_CATEGORIES = ['Food', 'Grocery', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Other'];

// Clean and validate the parsed receipt object before writing to Firestore.
function validateReceipt(raw) {
  return {
    merchant: typeof raw.merchant === 'string' ? raw.merchant.trim() : null,
    date: isValidDate(raw.date) ? raw.date : null,
    total: toPositiveNumber(raw.total),
    subtotal: toPositiveNumber(raw.subtotal),
    tax: toPositiveNumber(raw.tax),
    category: VALID_CATEGORIES.includes(raw.category) ? raw.category : 'Other',
    items: Array.isArray(raw.items)
      ? raw.items
          .filter(i => i && typeof i.name === 'string')
          .map(i => ({ name: i.name.trim(), price: toPositiveNumber(i.price) }))
      : [],
    currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : 'CAD',
  };
}

function isValidDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

function toPositiveNumber(val) {
  const n = parseFloat(val);
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

module.exports = { validateReceipt };
