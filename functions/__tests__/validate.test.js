const { validateReceipt } = require('../lib/validate');

describe('validateReceipt', () => {
  it('should sanitize basic valid input', () => {
    const raw = {
      merchant: '  Target  ',
      location: 'San Diego',
      date: '2026-04-25',
      total: 29.72,
      subtotal: 29.62,
      tax: '0.10',
      category: 'Grocery',
      subCategory: 'Supermarket',
      items: [
        { name: 'Apple ', price: 1.50 },
        { name: 'Banana', price: '0.99' }
      ],
      currency: 'usd',
      type: 'purchase',
      loyaltyPointsEarned: 10,
      loyaltyPointsBalance: 150
    };

    const result = validateReceipt(raw);

    expect(result).toEqual({
      merchant: 'Target',
      location: 'San Diego',
      date: '2026-04-25',
      total: 29.72,
      subtotal: 29.62,
      tax: 0.1,
      category: 'Grocery',
      subCategory: 'Supermarket',
      items: [
        { name: 'Apple', price: 1.5, quantity: 1, category: 'Grocery' },
        { name: 'Banana', price: 0.99, quantity: 1, category: 'Grocery' }
      ],
      currency: 'USD',
      type: 'purchase',
      isSubscription: false,
      loyaltyPointsEarned: 10,
      loyaltyPointsBalance: 150
    });
  });

  it('should handle missing or null fields gracefully', () => {
    const raw = {
      merchant: null,
      total: null,
      category: 'WeirdCategory',
      items: null
    };

    const result = validateReceipt(raw);

    expect(result).toEqual({
      merchant: null,
      location: null,
      date: null,
      total: null,
      subtotal: null,
      tax: null,
      category: 'Other', // Defaults to Other if invalid
      subCategory: null,
      items: [], // Defaults to empty array
      currency: 'CAD', // Default
      type: 'purchase', // Default
      isSubscription: false,
      loyaltyPointsEarned: null,
      loyaltyPointsBalance: null
    });
  });

  it('should clean up malformed dates and invalid numbers', () => {
    const raw = {
      merchant: 'Test',
      date: 'April 25, 2026', // invalid format
      total: 'abc', // invalid number
      tax: undefined,
    };

    const result = validateReceipt(raw);

    expect(result.date).toBeNull();
    expect(result.total).toBeNull();
    expect(result.tax).toBeNull();
  });

  it('should validate and default item-level categories', () => {
    const raw = {
      merchant: 'Walmart',
      category: 'Grocery',
      items: [
        { name: 'Milk', price: 5.5, category: 'Grocery' },
        { name: 'T-Shirt', price: 15.0, category: 'Shopping' },
        { name: 'Socks', price: 10.0, category: 'InvalidCat' },
        { name: 'Pens', price: 3.0 }
      ]
    };

    const result = validateReceipt(raw);

    expect(result.items).toEqual([
      { name: 'Milk', price: 5.5, quantity: 1, category: 'Grocery' },
      { name: 'T-Shirt', price: 15.0, quantity: 1, category: 'Shopping' },
      { name: 'Socks', price: 10.0, quantity: 1, category: 'Grocery' },
      { name: 'Pens', price: 3.0, quantity: 1, category: 'Grocery' }
    ]);
  });

  it('should normalize merchant names using the config map', () => {
    const raw1 = { merchant: 'FRESH CO' };
    const raw2 = { merchant: 'freshco' };
    const raw3 = { merchant: 'Walmart Supercenter' };
    const raw4 = { merchant: 'Unknown Store' };
    const raw5 = { merchant: 'OLD NAVY' };
    const raw6 = { merchant: 'old navy' };

    expect(validateReceipt(raw1).merchant).toBe('FreshCo');
    expect(validateReceipt(raw2).merchant).toBe('FreshCo');
    expect(validateReceipt(raw3).merchant).toBe('Walmart');
    expect(validateReceipt(raw4).merchant).toBe('Unknown Store');
    expect(validateReceipt(raw5).merchant).toBe('Old Navy');
    expect(validateReceipt(raw6).merchant).toBe('Old Navy');
  });
});

