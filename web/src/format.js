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
