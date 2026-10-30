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

describe('Transfer and Income (CIV-1189)', () => {
  const { isSpending, SPENDING_CATEGORIES } = require('../lib/categories');

  it.each([['transfer', 'Transfer'], ['Transfers', 'Transfer'], ['INCOME', 'Income']])('maps %j to %s', (input, expected) => {
    expect(resolveCategory(input)).toBe(expected);
  });

  it('counts every ordinary category, and entries with no category, as spending', () => {
    for (const category of SPENDING_CATEGORIES) expect(isSpending({ category })).toBe(true);
    expect(isSpending({})).toBe(true);
  });

  it('does not count Transfer or Income as spending', () => {
    expect(isSpending({ category: 'Transfer' })).toBe(false);
    expect(isSpending({ category: 'Income' })).toBe(false);
    expect(SPENDING_CATEGORIES).not.toContain('Transfer');
    expect(VALID_CATEGORIES).toEqual(expect.arrayContaining(['Transfer', 'Income']));
  });
});
