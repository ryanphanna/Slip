// Every category the server accepts. Mirrors VALID_CATEGORIES in
// functions/lib/categories.js; Transfer and Income are never counted as spending.
export const CATEGORIES = ['Takeout/Dining', 'Grocery', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Home', 'Other', 'Transfer', 'Income'];

// Empty field -> null (not 0); unparseable text is sent as-is so the server rejects it.
export function amountOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

export function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return String(value || '').trim().replace(/[^\d+]/g, '');
}

// "1 item", "2 items".
export function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatMoney(value, currency = 'CAD') {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(value);
}

export function formatPurchaseDate(value) {
  if (!value) return 'No date';
  const date = new Date(`${value}T00:00:00`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  return Number.isNaN(date.getTime()) ? value : `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatListDate(value) {
  if (!value) return 'No date';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const full = formatPurchaseDate(value);
  return date.getFullYear() === new Date().getFullYear() ? full.replace(/, \d{4}$/, '') : full;
}

export function failureDate(createdAt) {
  const seconds = createdAt?.seconds ?? createdAt?._seconds;
  return createdAt?.toDate?.() || (seconds ? new Date(seconds * 1000) : null);
}

export function formatFailureDate(createdAt, numMedia) {
  const date = failureDate(createdAt);
  const source = numMedia > 0 ? 'photo receipt' : 'pasted receipt';
  return `${date ? date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unprocessed'} · ${source}`;
}

export function formatFailureRange(failures) {
  const dates = failures.map((failure) => failureDate(failure.createdAt)).filter(Boolean).sort((a, b) => a - b);
  if (!dates.length) return '';
  const format = (date, includeYear = true) => date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(includeYear ? { year: 'numeric' } : {}) });
  if (dates[0].toDateString() === dates.at(-1).toDateString()) return `from ${format(dates[0])}`;
  const sameYear = dates[0].getFullYear() === dates.at(-1).getFullYear();
  return `from ${format(dates[0], !sameYear)}–${format(dates.at(-1))}`;
}

// Shows the public catalog name when it differs from the name printed on the receipt.
export function hasDistinctPublicName(item) {
  return Boolean(item.publicName && item.name && item.publicName.trim().toLowerCase() !== item.name.trim().toLowerCase());
}

const BAR_COLORS = ['#4a7c59', '#d9873f', '#6f8ba6', '#a8c490', '#c9b48a'];
// Extra colours for the recap page, which shows every category (CIV-1073).
const MORE_BAR_COLORS = ['#8a6d9e', '#b5653d', '#5f9e9a', '#d6a74a', '#7d7f4a', '#b07a8c', '#4f6d7a', '#9c8f7a'];

// Every positive category, largest first with Other last; no collapsing.
export function allCategorySegments(categories) {
  const palette = [...BAR_COLORS, ...MORE_BAR_COLORS];
  return Object.entries(categories || {})
    .filter(([, amount]) => Number.isFinite(amount) && amount > 0)
    .sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || b[1] - a[1])
    .map(([name, amount], index) => ({ name, amount, color: palette[index % palette.length] }));
}

// "$40.10 more than August", "$5.00 less than August", "Same as August".
export function comparisonLabel(current, previous, previousMonth) {
  const diff = Math.round(((current || 0) - (previous || 0)) * 100) / 100;
  if (diff === 0) return `Same as ${previousMonth}`;
  return `${formatMoney(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${previousMonth}`;
}

export function categorySegments(categories) {
  const positive = Object.entries(categories || {}).filter(([, amount]) => Number.isFinite(amount) && amount > 0).sort((a, b) => b[1] - a[1]);
  const top = positive.slice(0, 4);
  const rest = positive.slice(4);
  const otherIndex = top.findIndex(([name]) => name === 'Other');
  const restTotal = rest.reduce((sum, [, amount]) => sum + amount, 0);
  if (restTotal > 0) {
    if (otherIndex >= 0) top[otherIndex] = ['Other', top[otherIndex][1] + restTotal];
    else top.push(['Other', restTotal]);
  }
  top.sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || b[1] - a[1]);
  return top.map(([name, amount], index) => ({ name, amount, color: BAR_COLORS[index] }));
}

// Check marks set when a receipt is saved (CIV-1194). Mirrors CHECK_FIELDS in
// functions/lib/receipt-checks.js.
export const CHECK_FIELDS = ['possibleDuplicate', 'possibleDuplicateOf', 'dateNeedsCheck', 'totalsNeedCheck', 'currencyNeedsCheck', 'itemsNeedCheck', 'statementReview'];

export function isFlagged(receipt) {
  return Boolean(receipt.possibleDuplicate || receipt.dateNeedsCheck || receipt.totalsNeedCheck
    || receipt.currencyNeedsCheck || receipt.itemsNeedCheck || receipt.statementReview);
}

// "Card charge June 21, $51.13, LAMAISONSIMONS"; missing parts are left out.
export function chargeLabel(charge) {
  if (!charge) return '';
  // Amounts may arrive as numbers or number text.
  const value = typeof charge.amount === 'string' && charge.amount.trim() ? Number(charge.amount) : charge.amount;
  const amount = Number.isFinite(value) ? formatMoney(value) : '';
  const parts = [charge.date ? formatListDate(charge.date) : '', amount, charge.description || ''].filter(Boolean);
  return parts.length ? `Card charge ${parts.join(', ')}` : '';
}

// Plain reasons for a flagged receipt, one per mark.
export function flagReasons(receipt) {
  const statement = receipt.statementReview;
  return [
    ...(receipt.possibleDuplicate ? [{ key: 'duplicate', text: 'Possible duplicate of an earlier receipt', duplicateOf: receipt.possibleDuplicateOf || null }] : []),
    ...(receipt.dateNeedsCheck ? [{ key: 'date', text: 'Check the date' }] : []),
    ...(receipt.totalsNeedCheck ? [{ key: 'totals', text: 'Amounts don\'t add up' }] : []),
    ...(receipt.currencyNeedsCheck ? [{ key: 'currency', text: 'Check the currency' }] : []),
    ...(receipt.itemsNeedCheck ? [{ key: 'items', text: 'Items missing' }] : []),
    ...(statement ? [{ key: 'statement', text: [statement.reason, chargeLabel(statement.charge)].filter(Boolean).join(': ') || 'Check against a card charge' }] : []),
  ];
}

// The short line for a receipt row: the reasons, or a note that an
// explanation is waiting to be processed.
export function flagSummary(receipt) {
  if (!isFlagged(receipt)) return '';
  if (receipt.explanation?.text) return 'Explained, waiting to be processed';
  return flagReasons(receipt).map((reason) => reason.text).join(' · ');
}
