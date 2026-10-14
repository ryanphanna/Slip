// Currency handling for totals. Amounts in different currencies are never
// summed together (no FX conversion): CAD is the primary currency, and every
// other currency is reported separately. A missing currency counts as CAD.
const DEFAULT_CURRENCY = 'CAD';

function currencyOf(doc) {
  const code = typeof doc?.currency === 'string' ? doc.currency.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_CURRENCY;
}

// CAD -> "$12.34", USD -> "US$12.34", anything else -> "EUR 12.34".
function formatMoney(amount, currency = DEFAULT_CURRENCY) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toFixed(2);
  if (currency === DEFAULT_CURRENCY) return `${sign}$${abs}`;
  if (currency === 'USD') return `${sign}US$${abs}`;
  return `${sign}${currency} ${abs}`;
}

const receiptWord = (n) => (n === 1 ? 'receipt' : 'receipts');

// "Also spent: US$45.00 (2 receipts), EUR 30.00 (1 receipt)" or '' when none.
// With `note`, the receipt counts are replaced: "Also spent: US$45.00 (not counted in budgets)".
function alsoSpentLine(byCurrency, { note } = {}) {
  const entries = Object.entries(byCurrency || {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const parts = entries.map(([code, v]) => `${formatMoney(v.total, code)}${note ? '' : ` (${v.count} ${receiptWord(v.count)})`}`);
  return `Also spent: ${parts.join(', ')}${note ? ` (${note})` : ''}`;
}

module.exports = { DEFAULT_CURRENCY, currencyOf, formatMoney, alsoSpentLine };
