const { checkFlags, discountNotItemized, DISCOUNT_NOTE, isFlagged } = require('../lib/receipt-checks');

const when = new Date('2026-10-20T12:00:00');

describe('discountNotItemized', () => {
  it('is true when items are before a discount but subtotal + tax is the total', () => {
    expect(discountNotItemized({ items: [{ price: 4.49 }], subtotal: 2, tax: 0.1, total: 2.1 })).toBe(true);
  });

  it('is false when the total itself is off', () => {
    expect(discountNotItemized({ items: [{ price: 4.49 }], subtotal: 2, tax: 0.1, total: 3 })).toBe(false);
  });

  it('is false when items add up to less than the subtotal', () => {
    expect(discountNotItemized({ items: [{ price: 1 }], subtotal: 2, tax: 0.1, total: 2.1 })).toBe(false);
  });
});

describe('checkFlags', () => {
  it('marks a hidden discount with a note saying the total is right', () => {
    const flags = checkFlags({ date: '2026-10-20', items: [{ price: 4.49 }], subtotal: 2, tax: 0.1, total: 2.1 }, { receivedAt: when });
    expect(flags).toEqual({ totalsNeedCheck: true, checkNote: DISCOUNT_NOTE });
    expect(isFlagged(flags)).toBe(true);
  });

  it('gives no note when the amounts are simply wrong', () => {
    const flags = checkFlags({ date: '2026-10-20', items: [{ price: 2 }], subtotal: 2, tax: 0.1, total: 5 }, { receivedAt: when });
    expect(flags).toEqual({ totalsNeedCheck: true });
  });
});
