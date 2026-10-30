// Kinds of spending. The receipt reader's prompt (gemini.js) lists only these.
const SPENDING_CATEGORIES = ['Takeout/Dining', 'Grocery', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Home', 'Other'];

// Kept in history but never counted as spending (CIV-1189). Transfer: card
// payments, moves between your own accounts, and store-balance reloads whose
// purchases are logged too. Income: pay.
const NON_SPENDING_CATEGORIES = ['Transfer', 'Income'];

const VALID_CATEGORIES = [...SPENDING_CATEGORIES, ...NON_SPENDING_CATEGORIES];

const key = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Any capitalization, so a typed "transfer" is caught too.
function isSpendingCategory(category) {
  return !NON_SPENDING_CATEGORIES.some((name) => key(name) === key(category));
}

// The one rule every spending total, count, budget and recap uses.
function isSpending(doc) {
  return isSpendingCategory(doc?.category);
}

// Maps what a user typed to a canonical category: case-insensitive, tolerant of
// simple plurals (Groceries -> Grocery) and of either half of "Takeout/Dining".
// Returns null when there is no obvious match.
function resolveCategory(input) {
  const typed = key(input);
  if (!typed) return null;
  const forms = new Set([typed]);
  if (typed.endsWith('ies')) forms.add(`${typed.slice(0, -3)}y`);
  if (typed.endsWith('es')) forms.add(typed.slice(0, -2));
  if (typed.endsWith('s')) forms.add(typed.slice(0, -1));
  for (const category of VALID_CATEGORIES) {
    const names = [key(category), ...category.split('/').map(key)];
    if (names.some((name) => forms.has(name))) return category;
  }
  return null;
}

module.exports = { VALID_CATEGORIES, SPENDING_CATEGORIES, NON_SPENDING_CATEGORIES, isSpending, isSpendingCategory, resolveCategory };
