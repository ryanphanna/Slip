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
            ...(i.unitPrice != null ? { unitPrice: signed(i.unitPrice) } : {}),
            ...(i.lineTotal != null ? { lineTotal: signed(i.lineTotal) } : {}),
            quantity: Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : 1,
            category: VALID_CATEGORIES.includes(i.category) ? i.category : (VALID_CATEGORIES.includes(raw.category) ? raw.category : 'Other'),
            ...(i.verified === true ? { verified: true } : {}),
            ...(typeof i.publicName === 'string' && i.publicName.trim() ? { publicName: i.publicName.trim() } : {}),
            ...(typeof i.itemNumber === 'string' && i.itemNumber.trim()
              ? { itemNumber: i.itemNumber.trim() }
              : (merchant === 'IKEA' && extractIkeaItemNumber(i.name) ? { itemNumber: extractIkeaItemNumber(i.name) } : {})),
            ...(typeof i.upc === 'string' && i.upc.trim() ? { upc: i.upc.trim() } : {}),
            ...(typeof i.dpci === 'string' && i.dpci.trim() ? { dpci: i.dpci.trim() } : {}),
            ...(typeof i.productUrl === 'string' && i.productUrl.trim() ? { productUrl: i.productUrl.trim() } : {}),
            ...(typeof i.itemId === 'string' && i.itemId.trim() ? { itemId: i.itemId.trim() } : {}),
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

// Strict calendar check (rejects 2026-13-45 and 2026-02-31).
function isRealDate(val) {
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const d = new Date(`${val}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val;
}

function isValidDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

function editError(message) {
  const error = new Error(message);
  error.code = 'invalid-argument';
  return error;
}

// Strict number for edits: real numbers or plain numeric strings only. Never
// parseFloat-truncates ("1,234.50" would otherwise become 1). Empty -> null.
function strictAmount(val, label, { allowNull = true } = {}) {
  if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
    if (!allowNull) throw editError(`${label} is required`);
    return null;
  }
  const n = typeof val === 'number' ? val : (/^-?\d+(\.\d+)?$/.test(String(val).trim()) ? Number(String(val).trim()) : NaN);
  if (!Number.isFinite(n)) throw editError(`${label} must be a number like 1234.50`);
  return n;
}

// Validates only the fields present in an edit patch. Invalid values are
// rejected with an 'invalid-argument' error instead of being coerced to null
// (the SMS/Gemini path keeps validateReceipt's lenient coercion).
function normalizeEditPatch(patch) {
  const out = { ...patch };
  if ('date' in out && out.date !== null && out.date !== '' && !isRealDate(out.date)) {
    throw editError('Date must be a real date like 2026-03-14');
  }
  if ('date' in out && (out.date === '' || out.date === null)) out.date = null;
  if ('currency' in out && !(typeof out.currency === 'string' && /^[A-Z]{3}$/.test(out.currency))) {
    throw editError('Currency must be a 3-letter code like CAD');
  }
  if ('type' in out && !VALID_TYPES.includes(out.type)) throw editError('Type must be purchase or refund');
  if ('total' in out) out.total = strictAmount(out.total, 'Total', { allowNull: false });
  if ('subtotal' in out) out.subtotal = strictAmount(out.subtotal, 'Subtotal');
  if ('tax' in out) out.tax = strictAmount(out.tax, 'Tax');
  if ('items' in out) {
    if (!Array.isArray(out.items)) throw editError('Items must be a list');
    out.items = out.items.map((item, i) => {
      if (!item || typeof item !== 'object') throw editError(`Item ${i + 1} is invalid`);
      const next = { ...item, price: strictAmount(item.price, `Item ${i + 1} price`) };
      for (const key of ['unitPrice', 'lineTotal']) {
        if (item[key] != null && item[key] !== '') next[key] = strictAmount(item[key], `Item ${i + 1} ${key}`);
        else delete next[key];
      }
      if (item.quantity !== undefined && item.quantity !== null && item.quantity !== '') {
        const q = strictAmount(item.quantity, `Item ${i + 1} quantity`);
        if (!Number.isInteger(q) || q < 1) throw editError(`Item ${i + 1} quantity must be a whole number of 1 or more`);
        next.quantity = q;
      } else {
        delete next.quantity;
      }
      return next;
    });
  }
  return out;
}

function toNumber(val) {
  const n = parseFloat(val);
  // Allow negative numbers so refunds can have negative totals/items
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

module.exports = { validateReceipt, normalizeMerchant, extractIkeaItemNumber, VALID_CATEGORIES, VALID_TYPES, isRealDate, normalizeEditPatch };
