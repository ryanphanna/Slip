const { validateReceipt, extractIkeaItemNumber, normalizeEditPatch, isRealDate } = require('../lib/validate');

describe('validateReceipt', () => {
  it('preserves clear IKEA article numbers from OCR item names', () => {
    const result = validateReceipt({
      merchant: 'IKEA',
      category: 'Home',
      items: [
        { name: 'ADLAD scented (article 905.027.28)', price: 4.72 },
        { name: 'HÄRMHOK lavender bag (article 506149)', price: 2.29 },
      ],
    });

    expect(extractIkeaItemNumber('DVALA (article 60577536)')).toBe('60577536');
    expect(result.items[0].itemNumber).toBe('90502728');
    expect(result.items[1].itemNumber).toBeUndefined();
  });

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

  it('should always store refund amounts as negative, regardless of the sign Gemini returned', () => {
    const raw = {
      merchant: 'Target',
      type: 'refund',
      total: 16.56,
      subtotal: 14.99,
      tax: 1.57,
      items: [{ name: 'HEYDAY', price: 14.99, category: 'Shopping' }],
    };

    const result = validateReceipt(raw);

    expect(result.total).toBe(-16.56);
    expect(result.subtotal).toBe(-14.99);
    expect(result.tax).toBe(-1.57);
    expect(result.items[0].price).toBe(-14.99);
  });

  it('should always store purchase amounts as positive, even if Gemini returned a negative sign', () => {
    const raw = {
      merchant: 'Target',
      type: 'purchase',
      total: -29.72,
      items: [{ name: 'FD', price: -4.29, category: 'Grocery' }],
    };

    const result = validateReceipt(raw);

    expect(result.total).toBe(29.72);
    expect(result.items[0].price).toBe(4.29);
  });
});

describe('SMS-path coercion is unchanged', () => {
  it('still silently nulls a bad date and truncates comma amounts', () => {
    const r = validateReceipt({ merchant: 'X', date: '2026-13-45', total: '1,234.50', currency: 'cad' });
    expect(r.date).toBe('2026-13-45'); // lenient regex-only check, as before
    expect(r.total).toBe(1);
    expect(r.currency).toBe('CAD');
  });
});

describe('normalizeEditPatch (strict edit path)', () => {
  it.each([
    ['impossible month/day', { date: '2026-13-45' }],
    ['non-existent day', { date: '2026-02-31' }],
    ['wrong format', { date: '03/14/2026' }],
    ['lowercase currency', { currency: 'cad' }],
    ['long currency', { currency: 'CADD' }],
    ['comma amount', { total: '1,234.50' }],
    ['text amount', { total: 'abc' }],
    ['empty total', { total: '' }],
    ['null total', { total: null }],
    ['bad subtotal', { subtotal: '$5' }],
    ['bad tax', { tax: '1,5' }],
    ['bad type', { type: 'gift' }],
    ['non-array items', { items: 'x' }],
    ['bad item price', { items: [{ name: 'a', price: '1,5' }] }],
    ['fractional quantity', { items: [{ name: 'a', price: 1, quantity: 1.5 }] }],
    ['zero quantity', { items: [{ name: 'a', price: 1, quantity: 0 }] }],
  ])('rejects %s', (_n, patch) => {
    expect(() => normalizeEditPatch(patch)).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
  });

  it('accepts and normalizes good values', () => {
    const out = normalizeEditPatch({
      date: '2026-03-14', currency: 'USD', total: '1234.50', subtotal: '', tax: null,
      items: [{ name: 'a', price: '2.5', quantity: '2' }],
    });
    expect(out).toMatchObject({ date: '2026-03-14', currency: 'USD', total: 1234.5, subtotal: null, tax: null });
    expect(out.items[0]).toMatchObject({ price: 2.5, quantity: 2 });
  });

  it('only checks fields present in the patch', () => {
    expect(normalizeEditPatch({ merchant: 'Costco' })).toEqual({ merchant: 'Costco' });
  });

  it('isRealDate rejects impossible dates', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-13-45')).toBe(false);
  });
});
