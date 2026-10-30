const config = require('./config');

const { VALID_CATEGORIES } = require('./categories');
const VALID_TYPES = ['purchase', 'refund'];

function normalizeMerchant(name) {
  if (typeof name !== 'string') return null;
  const clean = name.trim();
  const lower = clean.toLowerCase();

  // Try direct lookup in the normalization map
  if (config.MERCHANT_NORMALIZE_MAP && config.MERCHANT_NORMALIZE_MAP[lower]) {
    return config.MERCHANT_NORMALIZE_MAP[lower];
  }

  // Whole-word match, so "Walmart Supercenter" -> "Walmart" and "METRO #123" ->
  // "Metro", but "Metrolinx" (or any longer word that merely contains a key) is left alone.
  // Brackets after another name are a detail, not the store: "Token Transit
  // (NFTA Metro)" and "Uber Eats (Walmart)" stay as they are (CIV-1159).
  const outside = lower.replace(/\([^)]*\)/g, ' ').trim() || lower;
  for (const [key, canonical] of Object.entries(config.MERCHANT_NORMALIZE_MAP || {})) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(outside)) {
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

const RECEIPT_TIME_ZONE = 'America/Toronto';
const MAX_RECEIPT_AGE_DAYS = 120;

// Calendar date (YYYY-MM-DD) of `when` in Slip's home time zone.
function localDateString(when = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RECEIPT_TIME_ZONE }).format(when);
}

// True when a parsed receipt date is probably a misread: not a real calendar
// date, after the day the receipt arrived (one day of slack for time zones),
// or months before it. Wrong years (2026 read as 2024) and YY/MM/DD dates read
// as DD/MM/YY both land far outside this window.
function dateLooksWrong(date, receivedAt = new Date()) {
  if (date == null) return false;
  if (!isRealDate(date)) return true;
  const received = Date.parse(`${localDateString(receivedAt)}T00:00:00Z`);
  const days = (Date.parse(`${date}T00:00:00Z`) - received) / 86400000;
  return days > 1 || days < -MAX_RECEIPT_AGE_DAYS;
}

const AMOUNT_TOLERANCE = 0.05;

// True when a parsed receipt's numbers don't add up: the items don't sum to
// the subtotal, or subtotal + tax isn't the total. Only checks the parts the
// receipt has. A whole-receipt discount the items don't reflect (e.g. a 10%
// card discount at the bottom) also trips it, which is worth a look too.
function totalsLookWrong(receipt) {
  const off = (a, b) => Math.abs(a - b) > AMOUNT_TOLERANCE;
  const { subtotal, tax, total } = receipt;
  const prices = Array.isArray(receipt.items)
    ? receipt.items.map(i => i.price).filter(p => typeof p === 'number')
    : [];
  if (prices.length > 0 && typeof subtotal === 'number' && off(prices.reduce((a, b) => a + b, 0), subtotal)) {
    return true;
  }
  return typeof subtotal === 'number' && typeof tax === 'number' && typeof total === 'number'
    && off(subtotal + tax, total);
}

// True when a photo receipt was saved with no line items. Every printed
// receipt lists at least one item (the reader escalates to the stronger model
// when one comes back empty), so none means a missed read. Only call it for
// photo receipts: pasted text and AI imports may legitimately have no items.
function itemsLookMissing(receipt) {
  return !Array.isArray(receipt.items) || receipt.items.length === 0;
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

const ITEM_STRING_LIMITS = { name: 200, publicName: 200, itemNumber: 64, upc: 32, dpci: 32, productUrl: 500 };

// Validates an item edit. Only the editable fields are kept; wrong types are
// rejected with 'invalid-argument' instead of being stored.
function normalizeItemPatch(patch) {
  if (patch === undefined || patch === null) return {};
  if (typeof patch !== 'object' || Array.isArray(patch)) throw editError('patch must be an object');
  const allowed = [...Object.keys(ITEM_STRING_LIMITS), 'category', 'verified'];
  const out = {};
  for (const key of allowed) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (key === 'verified') {
      if (typeof value !== 'boolean') throw editError('verified must be true or false');
      out.verified = value;
    } else if (key === 'category') {
      if (!VALID_CATEGORIES.includes(value)) throw editError(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
      out.category = value;
    } else {
      if (typeof value !== 'string') throw editError(`${key} must be text`);
      const trimmed = value.trim();
      if (trimmed.length > ITEM_STRING_LIMITS[key]) throw editError(`${key} must be at most ${ITEM_STRING_LIMITS[key]} characters`);
      if (key === 'name' && !trimmed) throw editError('name cannot be empty');
      if (key === 'productUrl' && trimmed && !/^https?:\/\/\S+$/i.test(trimmed)) throw editError('productUrl must start with http:// or https://');
      out[key] = trimmed;
    }
  }
  return out;
}

function toNumber(val) {
  const n = parseFloat(val);
  // Allow negative numbers so refunds can have negative totals/items
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

module.exports = { validateReceipt, normalizeMerchant, extractIkeaItemNumber, VALID_CATEGORIES, VALID_TYPES, isRealDate, dateLooksWrong, totalsLookWrong, itemsLookMissing, localDateString, normalizeEditPatch, normalizeItemPatch };
