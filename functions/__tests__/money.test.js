const { currencyOf, formatMoney, alsoSpentLine } = require('../lib/money');

describe('money helpers', () => {
  it('treats missing or invalid currency as CAD', () => {
    expect(currencyOf({})).toBe('CAD');
    expect(currencyOf({ currency: 'usd' })).toBe('USD');
    expect(currencyOf({ currency: 'dollars' })).toBe('CAD');
    expect(currencyOf(null)).toBe('CAD');
  });
  it('formats CAD, USD and other currencies', () => {
    expect(formatMoney(12.5)).toBe('$12.50');
    expect(formatMoney(45, 'USD')).toBe('US$45.00');
    expect(formatMoney(30, 'EUR')).toBe('EUR 30.00');
    expect(formatMoney(-4, 'USD')).toBe('-US$4.00');
  });
  it('builds the "Also spent" line, empty when nothing', () => {
    expect(alsoSpentLine(undefined)).toBe('');
    expect(alsoSpentLine({})).toBe('');
    expect(alsoSpentLine({ USD: { total: 45, count: 2 }, EUR: { total: 30, count: 1 } })).toBe('Also spent: EUR 30.00 (1 receipt), US$45.00 (2 receipts)');
    expect(alsoSpentLine({ USD: { total: 45, count: 2 } }, { note: 'not counted in budgets' })).toBe('Also spent: US$45.00 (not counted in budgets)');
  });
});
