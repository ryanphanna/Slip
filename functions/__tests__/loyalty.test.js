const { programOf, pointsFromDocs } = require('../lib/loyalty');

const at = (day) => ({ toMillis: () => Date.parse(`${day}T12:00:00`) });

describe('programOf', () => {
  it('groups PC Optimum stores, whatever the spelling', () => {
    for (const name of ['Loblaws', 'NOFRILLS', 'No Frills', 'nofrills', 'Shoppers Drug Mart', 'Real Canadian Superstore', 'Superstore']) {
      expect(programOf(name)).toBe('PC Optimum');
    }
  });

  it('names the other known programs and leaves unknown stores as themselves', () => {
    expect(programOf('FreshCo')).toBe('Scene+');
    expect(programOf('Rexall')).toBe('Be Well');
    expect(programOf('Metro')).toBe('moi');
    expect(programOf('Indigo')).toBe('Indigo');
  });

  it('does not treat a longer name as a known store', () => {
    expect(programOf('Metrolinx')).toBe('Metrolinx');
  });
});

describe('pointsFromDocs', () => {
  const today = new Date(2026, 9, 29);
  const docs = [
    { id: 'a', merchant: 'Loblaws', date: '2026-10-04', loyaltyPointsEarned: 900, loyaltyPointsBalance: 527403, createdAt: at('2026-10-05') },
    { id: 'b', merchant: 'NOFRILLS', date: '2026-10-15', loyaltyPointsEarned: 700, loyaltyPointsBalance: 547648, createdAt: at('2026-10-16') },
    { id: 'c', merchant: 'No Frills', date: '2026-09-19', loyaltyPointsEarned: 100, createdAt: at('2026-10-21') },
    { id: 'd', merchant: 'LCBO', date: '2026-06-25', loyaltyPointsEarned: 2, createdAt: at('2026-06-26') },
    { id: 'e', merchant: 'Costco', date: '2026-10-01', total: 50, createdAt: at('2026-10-01') },
    // Wrong-year reading: older by date, so it never wins the latest balance.
    { id: 'f', merchant: 'Shoppers Drug Mart', date: '2018-05-26', loyaltyPointsEarned: 90, loyaltyPointsBalance: 513013, createdAt: at('2026-10-28') },
  ];
  const programs = pointsFromDocs(docs, today);
  const pc = programs.find((p) => p.name === 'PC Optimum');

  it('takes the balance from the latest receipt by date, with its store and id', () => {
    expect(pc).toMatchObject({ balance: 547648, balanceDate: '2026-10-15', balanceStore: 'No Frills', balanceReceiptId: 'b', receiptCount: 4 });
  });

  it('merges store spellings into one name', () => {
    expect(pc.stores).toEqual(['Loblaws', 'No Frills', 'Shoppers Drug Mart']);
  });

  it('adds up points earned for the last six months, by the month printed', () => {
    expect(pc.earnedByMonth).toEqual([
      { monthKey: '2026-05', points: 0 }, { monthKey: '2026-06', points: 0 }, { monthKey: '2026-07', points: 0 },
      { monthKey: '2026-08', points: 0 }, { monthKey: '2026-09', points: 100 }, { monthKey: '2026-10', points: 1600 },
    ]);
  });

  it('keeps programs with no balance, after those with one, and skips receipts with no points', () => {
    expect(programs.map((p) => p.name)).toEqual(['PC Optimum', 'LCBO']);
    expect(programs[1]).toMatchObject({ balance: null, receiptCount: 1 });
  });
});
