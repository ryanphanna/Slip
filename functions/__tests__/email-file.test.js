const { matchExisting, lineTotalItems } = require('../lib/email-file');

describe('matchExisting', () => {
  const existing = [
    { id: 'wing', merchant: 'Wingstop Canada', date: '2026-07-17', total: 21.8, currency: 'CAD' },
    { id: 'ferry', merchant: 'Ferries to Toronto Island Park', date: '2026-07-10', total: 9.57 },
    { id: 'wendys', merchant: "Wendy's", date: '2026-09-04', total: 14.96, currency: 'USD' },
    { id: 'simons', merchant: 'Simons', date: '2026-06-24', total: -79, type: 'refund' },
    { id: 'cup', merchant: 'Second Cup Café', date: '2026-07-25', total: 6.72 },
    { id: 'indigo', merchant: 'Indigo', date: '2026-08-28', total: 14.68 },
  ];

  it('finds a receipt already in Slip under another store spelling or a day apart', () => {
    const matches = matchExisting([
      { merchant: 'Wingstop', date: '2026-07-17', total: 21.8, currency: 'CAD' },
      { merchant: 'Toronto Island Ferry', date: '2026-07-10', total: 9.57, currency: 'CAD' },
      { merchant: "Wendy's", date: '2026-09-03', total: 14.96, currency: 'USD' },
      { merchant: 'Simons', date: '2026-06-24', total: 79, currency: 'CAD', type: 'refund' },
    ], existing);
    expect([...matches.values()].map((doc) => doc.id)).toEqual(['wing', 'ferry', 'simons', 'wendys']);
  });

  it('does not match a different store with the same amount', () => {
    expect(matchExisting([{ merchant: 'Apple', date: '2026-08-29', total: 14.68, currency: 'CAD' }], existing).size).toBe(0);
  });

  it('does not match another currency', () => {
    expect(matchExisting([{ merchant: 'Wingstop', date: '2026-07-17', total: 21.8, currency: 'USD' }], existing).size).toBe(0);
  });

  it('lets one existing receipt match only one, same day first', () => {
    const matches = matchExisting([
      { merchant: 'Second Cup', date: '2026-07-23', total: 6.72, currency: 'CAD' },
      { merchant: 'Second Cup', date: '2026-07-25', total: 6.72, currency: 'CAD' },
    ], existing);
    expect([...matches.keys()]).toEqual([1]);
  });
});

describe('lineTotalItems', () => {
  it('turns unit prices into line totals when only that adds up', () => {
    const items = lineTotalItems({ subtotal: 5, items: [{ name: 'Apple', price: 2.5, quantity: 2 }] });
    expect(items).toEqual([{ name: 'Apple', price: 5, quantity: 2 }]);
  });

  it('leaves line totals alone', () => {
    const receipt = { subtotal: 5, items: [{ name: 'Apple', price: 5, quantity: 2 }] };
    expect(lineTotalItems(receipt)).toBe(receipt.items);
  });

  it('leaves items alone when neither way adds up', () => {
    const receipt = { subtotal: 9, items: [{ name: 'Apple', price: 2.5, quantity: 2 }] };
    expect(lineTotalItems(receipt)).toBe(receipt.items);
  });
});
