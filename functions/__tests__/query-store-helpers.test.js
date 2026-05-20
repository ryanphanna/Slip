const { countRecentReceipts } = require('../lib/store');
const { findLatestReceiptForSender } = require('../lib/query');

function makeDoc(from, createdAt, data = {}) {
  return {
    get(field) {
      if (field === 'from') return from;
      if (field === 'createdAt') {
        return createdAt ? { toDate: () => createdAt } : null;
      }
      return data[field];
    },
    data() {
      return { from, createdAt, ...data };
    },
  };
}

describe('query/store index-light helpers', () => {
  it('counts only recent receipts for the matching sender', () => {
    const now = new Date('2026-05-20T21:40:00.000Z');
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const docs = [
      makeDoc('+1', new Date('2026-05-20T21:39:00.000Z')),
      makeDoc('+2', new Date('2026-05-20T21:38:00.000Z')),
      makeDoc('+1', new Date('2026-05-20T21:10:00.000Z')),
      makeDoc('+1', new Date('2026-05-20T19:00:00.000Z')),
    ];

    expect(countRecentReceipts(docs, '+1', oneHourAgo, 2)).toBe(true);
    expect(countRecentReceipts(docs, '+1', oneHourAgo, 3)).toBe(false);
  });

  it('finds the latest receipt for the matching sender', () => {
    const docs = [
      makeDoc('+2', new Date('2026-05-20T21:39:00.000Z'), { merchant: 'Other' }),
      makeDoc('+1', new Date('2026-05-20T21:38:00.000Z'), { merchant: 'FreshCo' }),
      makeDoc('+1', new Date('2026-05-20T20:00:00.000Z'), { merchant: 'Metro' }),
    ];

    expect(findLatestReceiptForSender(docs, '+1')).toEqual(
      expect.objectContaining({ merchant: 'FreshCo', from: '+1' })
    );
    expect(findLatestReceiptForSender(docs, '+9')).toBeNull();
  });
});
