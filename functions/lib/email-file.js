// Helpers for loading a receipts file made by an AI assistant from receipt
// emails (docs/AI_RECEIPTS.md, CIV-1159).

const DAY_MS = 86400000;
const STOP_WORDS = new Set(['the', 'and', 'inc', 'ltd', 'canada', 'store', 'cafe']);

// The words that identify a store: "Wingstop Canada" and "Wingstop" share
// "wingstop"; "Ferries to Toronto Island Park" and "Toronto Island Ferry"
// share "toronto" and "island".
function storeWords(merchant) {
  return new Set(String(merchant || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)));
}

function sameStore(a, b) {
  const words = storeWords(b);
  return [...storeWords(a)].some((word) => words.has(word));
}

const dayGap = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

// Receipts in the file that are already in Slip (texted in, or imported
// another way), where Slip's own duplicate check needs the exact store
// spelling and date. A match is the same amount and currency, a store name
// sharing a word, and a date at most `maxDays` apart. Each existing receipt
// matches at most one file receipt, same-day matches first, so two real
// identical coffees two days apart are not both dropped. Returns a Map of
// file index -> existing receipt.
function matchExisting(receipts, existing, { maxDays = 2 } = {}) {
  const matches = new Map();
  const claimed = new Set();
  const candidates = existing.filter((doc) => doc.date && typeof doc.total === 'number');
  for (const pass of [0, maxDays]) {
    receipts.forEach((receipt, index) => {
      if (matches.has(index) || !receipt.date || typeof receipt.total !== 'number') return;
      const found = candidates.find((doc) => !claimed.has(doc.id)
        && Math.abs(Math.abs(doc.total) - Math.abs(receipt.total)) < 0.005
        && (doc.currency || 'CAD') === (receipt.currency || 'CAD')
        && dayGap(doc.date, receipt.date) <= pass
        && sameStore(doc.merchant, receipt.merchant));
      if (found) {
        claimed.add(found.id);
        matches.set(index, found);
      }
    });
  }
  return matches;
}

const cents = (n) => Math.round(n * 100) / 100;

// Item prices are line totals in Slip. When an assistant wrote unit prices
// with a quantity instead, and only the line totals add up to the subtotal
// (or the total when there is no subtotal and tax), returns the items with
// line totals; otherwise returns them unchanged.
function lineTotalItems(receipt) {
  const items = receipt.items;
  if (!Array.isArray(items) || !items.some((item) => (item.quantity || 1) > 1)) return items;
  const target = typeof receipt.subtotal === 'number' ? receipt.subtotal
    : receipt.tax == null ? receipt.total : null;
  if (typeof target !== 'number') return items;
  const sum = (list) => list.reduce((total, item) => total + (item.price || 0), 0);
  const lines = items.map((item) => ({ ...item, price: cents((item.price || 0) * (item.quantity || 1)) }));
  const close = (a) => Math.abs(a - target) <= 0.05;
  return close(sum(lines)) && !close(sum(items)) ? lines : items;
}

module.exports = { matchExisting, lineTotalItems, storeWords };
