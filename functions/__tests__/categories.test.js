const { resolveCategory, VALID_CATEGORIES } = require('../lib/categories');

describe('resolveCategory', () => {
  it.each([
    ['Grocery', 'Grocery'],
    ['grocery', 'Grocery'],
    ['GROCERY', 'Grocery'],
    ['Groceries', 'Grocery'],
    ['groceries', 'Grocery'],
    ['transports', 'Transport'],
    ['Homes', 'Home'],
    ['  Health  ', 'Health'],
    ['entertainment', 'Entertainment'],
    ['Takeout/Dining', 'Takeout/Dining'],
    ['takeout', 'Takeout/Dining'],
    ['Dining', 'Takeout/Dining'],
    ['takeout dining', 'Takeout/Dining'],
    ['other', 'Other'],
    ['shopping', 'Shopping'],
  ])('maps %j to %s', (input, expected) => {
    expect(resolveCategory(input)).toBe(expected);
  });

  it.each([['Crypto'], ['Gas'], [''], [null], [undefined], ['///'], ['Grocer'], ['Foodstuffs']])('returns null for %j', (input) => {
    expect(resolveCategory(input)).toBeNull();
  });

  it('every canonical category maps to itself', () => {
    for (const c of VALID_CATEGORIES) expect(resolveCategory(c)).toBe(c);
  });
});
