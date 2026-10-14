const { aggregateSpendingByCategory } = require('../lib/query');

describe('aggregateSpendingByCategory', () => {
  it('returns zero totals for no receipts', () => {
    expect(aggregateSpendingByCategory([])).toEqual({ total: 0, categories: {} });
  });

  it('skips receipts with no total', () => {
    const result = aggregateSpendingByCategory([{ total: null, category: 'Grocery' }]);
    expect(result).toEqual({ total: 0, categories: {} });
  });

  it('buckets an itemless receipt under its own category', () => {
    const result = aggregateSpendingByCategory([{ total: 25, category: 'Grocery' }]);
    expect(result).toEqual({ total: 25, categories: { Grocery: 25 } });
  });

  it('falls back to Other when a receipt has no category', () => {
    const result = aggregateSpendingByCategory([{ total: 10 }]);
    expect(result.categories).toEqual({ Other: 10 });
  });

  it('splits an itemized receipt across per-item categories', () => {
    const result = aggregateSpendingByCategory([{
      total: 30,
      category: 'Shopping',
      items: [
        { name: 'Milk', price: 5, category: 'Grocery' },
        { name: 'Shirt', price: 25, category: 'Shopping' },
      ],
    }]);
    expect(result).toEqual({ total: 30, categories: { Grocery: 5, Shopping: 25 } });
  });

  it('allocates the tax/rounding gap between items and total to the receipt category', () => {
    const result = aggregateSpendingByCategory([{
      total: 21.60,
      category: 'Grocery',
      items: [{ name: 'Bread', price: 20, category: 'Grocery' }],
    }]);
    // 1.60 tax gap gets folded into Grocery alongside the item price
    expect(result).toEqual({ total: 21.6, categories: { Grocery: 21.6 } });
  });

  it('does not fold a sub-cent rounding gap into the category total', () => {
    const result = aggregateSpendingByCategory([{
      total: 20.0001,
      category: 'Grocery',
      items: [{ name: 'Bread', price: 20, category: 'Grocery' }],
    }]);
    expect(result.categories.Grocery).toBe(20);
  });

  it('treats a missing item price as zero rather than skipping the item', () => {
    const result = aggregateSpendingByCategory([{
      total: 10,
      category: 'Grocery',
      items: [{ name: 'Free sample', category: 'Grocery' }, { name: 'Bread', price: 10, category: 'Grocery' }],
    }]);
    expect(result.categories.Grocery).toBe(10);
  });

  it('falls back an item with no category to the receipt category, then Other', () => {
    const withReceiptCategory = aggregateSpendingByCategory([{
      total: 5, category: 'Grocery', items: [{ name: 'Milk', price: 5 }],
    }]);
    expect(withReceiptCategory.categories).toEqual({ Grocery: 5 });

    const withNoCategoryAtAll = aggregateSpendingByCategory([{
      total: 5, items: [{ name: 'Milk', price: 5 }],
    }]);
    expect(withNoCategoryAtAll.categories).toEqual({ Other: 5 });
  });

  it('aggregates across multiple receipts and rounds to cents', () => {
    const result = aggregateSpendingByCategory([
      { total: 10.005, category: 'Grocery' },
      { total: 10.005, category: 'Grocery' },
    ]);
    expect(result.total).toBe(20.01);
    expect(result.categories.Grocery).toBe(20.01);
  });

  it('treats refunds (negative totals) as reducing the category total', () => {
    const result = aggregateSpendingByCategory([
      { total: 50, category: 'Shopping' },
      { total: -20, category: 'Shopping' },
    ]);
    expect(result).toEqual({ total: 30, categories: { Shopping: 30 } });
  });
});

describe('aggregateSpendingByCategory across currencies', () => {
  const docs = [
    { total: 10, category: 'Grocery' },
    { total: 20, category: 'Grocery', currency: 'CAD' },
    { total: 45, category: 'Shopping', currency: 'USD' },
    { total: 30, category: 'Home', currency: 'EUR', items: [{ price: 20, category: 'Home' }] },
  ];

  it('never sums across currencies: CAD headline plus per-currency groups', () => {
    const r = aggregateSpendingByCategory(docs);
    expect(r.total).toBe(30);
    expect(r.categories).toEqual({ Grocery: 30 });
    expect(r.byCurrency).toEqual({
      USD: { total: 45, categories: { Shopping: 45 }, count: 1 },
      EUR: { total: 30, categories: { Home: 30 }, count: 1 },
    });
  });

  it('omits byCurrency when everything is CAD', () => {
    expect(aggregateSpendingByCategory([{ total: 5, category: 'Grocery' }])).not.toHaveProperty('byCurrency');
  });

  it('a month with only USD receipts has a zero CAD total', () => {
    const r = aggregateSpendingByCategory([{ total: 45, currency: 'USD', category: 'Shopping' }]);
    expect(r.total).toBe(0);
    expect(r.byCurrency.USD.total).toBe(45);
  });
});

