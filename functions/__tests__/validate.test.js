const { validateReceipt, extractIkeaItemNumber, normalizeEditPatch, isRealDate, dateLooksWrong, localDateString, normalizeMerchant } = require('../lib/validate');
const config = require('../lib/config');

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

describe('normalizeMerchant whole-word matching', () => {
  it.each([
    ['METRO #123', 'Metro'],
    ['Metro Inc', 'Metro'],
    ['Metro Inc.', 'Metro'],
    ['metro', 'Metro'],
    ['Metro - Bloor St', 'Metro'],
    ['Walmart Supercenter', 'Walmart'],
    ['WAL-MART #1234', 'Walmart'],
    ['Wal-Mart', 'Walmart'],
    ['IKEA North York', 'IKEA'],
    ['Ikea', 'IKEA'],
    ['FRESH CO', 'FreshCo'],
    ['FreshCo #204', 'FreshCo'],
    ['Whole Foods', 'Whole Foods Market'],
    ['WHOLE FOODS MARKET #12', 'Whole Foods Market'],
    ["Trader Joe's #5", "Trader Joe's"],
    ['trader joes', "Trader Joe's"],
    ['TIM HORTONS 1234', 'Tim Hortons'],
    ['T&T Supermarket Markham', 'T&T Supermarket'],
    ['Shoppers Drug Mart #1', 'Shoppers Drug Mart'],
    ['Loblaws Toronto', 'Loblaws'],
    ['OLD NAVY', 'Old Navy'],
    ['Uniqlo Eaton Centre', 'Uniqlo'],
    ['Real Canadian Superstore', 'Superstore'],
    ['Homesense #8', 'Homesense'],
    ['Walgreens #1', 'Walgreens'],
    ['Rexall Pharma Plus', 'Rexall'],
    ['Target (Brampton)', 'Target'],
    ['  Target  ', 'Target'],
  ])('maps %j to %j', (input, expected) => {
    expect(normalizeMerchant(input)).toBe(expected);
  });

  it.each([
    ['Metrolinx'],
    ['METROLINX / PRESTO'],
    ['Metropolitan Museum'],
    ['Targeted Marketing Inc'],
    ['Retarget Co'],
    ['Superstorey'],
    ['Ikeabox'],
    ['Walmartx'],
    ['Rexallton'],
    ['Unknown Store'],
  ])('leaves %j unchanged (key only appears inside a longer word)', (input) => {
    expect(normalizeMerchant(input)).toBe(input);
  });

  it('returns null for non-strings and trims otherwise', () => {
    expect(normalizeMerchant(null)).toBeNull();
    expect(normalizeMerchant(42)).toBeNull();
    expect(normalizeMerchant('  Corner Shop ')).toBe('Corner Shop');
  });

  // Differential check against the previous substring behavior: for every key in
  // the map, every realistic way a receipt prints it still maps the same way.
  it('keeps every legitimate mapping the old substring matcher produced', () => {
    const oldNormalize = (name) => {
      const clean = name.trim();
      const lower = clean.toLowerCase();
      if (config.MERCHANT_NORMALIZE_MAP[lower]) return config.MERCHANT_NORMALIZE_MAP[lower];
      for (const [key, canonical] of Object.entries(config.MERCHANT_NORMALIZE_MAP)) if (lower.includes(key)) return canonical;
      return clean;
    };
    const wrappers = ['%s', '%s #123', '%s Inc', '%s Inc.', '%s - Downtown', '%s, Toronto', '(%s)', 'The %s', '%s/%s', '%s 4521', '%s#9'];
    let checked = 0;
    for (const key of Object.keys(config.MERCHANT_NORMALIZE_MAP)) {
      for (const variant of [key, key.toUpperCase(), key.replace(/\b\w/g, (c) => c.toUpperCase())]) {
        for (const wrapper of wrappers) {
          const input = wrapper.replace(/%s/g, variant);
          expect(normalizeMerchant(input)).toBe(oldNormalize(input));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('validateReceipt uses the stricter matching', () => {
    expect(validateReceipt({ merchant: 'Metrolinx' }).merchant).toBe('Metrolinx');
    expect(validateReceipt({ merchant: 'METRO #123' }).merchant).toBe('Metro');
  });
});

describe('dateLooksWrong', () => {
  const received = new Date('2026-10-21T16:00:00Z');

  it('accepts recent dates and a missing date', () => {
    expect(dateLooksWrong('2026-10-21', received)).toBe(false);
    expect(dateLooksWrong('2026-10-22', received)).toBe(false);
    expect(dateLooksWrong('2026-07-01', received)).toBe(false);
    expect(dateLooksWrong(null, received)).toBe(false);
  });

  it('flags a wrong year, a misordered YY/MM/DD date, the future, and impossible dates', () => {
    expect(dateLooksWrong('2024-10-19', received)).toBe(true);
    expect(dateLooksWrong('2019-08-26', received)).toBe(true);
    expect(dateLooksWrong('2026-10-25', received)).toBe(true);
    expect(dateLooksWrong('2026-02-30', received)).toBe(true);
  });

  it('uses Toronto time for the received day', () => {
    // 02:00 UTC on Oct 22 is still Oct 21 in Toronto.
    expect(localDateString(new Date('2026-10-22T02:00:00Z'))).toBe('2026-10-21');
  });
});
