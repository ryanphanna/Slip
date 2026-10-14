const VALID_CATEGORIES = ['Takeout/Dining', 'Grocery', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Home', 'Other'];

const key = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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

module.exports = { VALID_CATEGORIES, resolveCategory };
