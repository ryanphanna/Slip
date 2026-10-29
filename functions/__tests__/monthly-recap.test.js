const { createFakeFirestore } = require('../test-helpers/fake-firestore');

let fake;
jest.mock('firebase-admin', () => ({ firestore: jest.fn(), storage: jest.fn() }));
jest.mock('../lib/twilio', () => ({ sendSms: jest.fn() }));
jest.mock('../lib/receipt', () => ({ parseReceiptFromBase64: jest.fn(), parseReceiptFromText: jest.fn() }));

const admin = require('firebase-admin');
const { sendSms } = require('../lib/twilio');
const { sendMonthlyDigest } = require('../lib/digest');
const { getMonthlyRecap } = require('../lib/web-api');
const { shiftMonthKey, isMonthKey, getMonthlyStats } = require('../lib/query');

process.env.ALLOWED_PHONES = '+14165551234,+14165559999';
const FROM = '+14165551234';
const OTHER = '+14165559999';
const AUTH = { auth: { uid: 'user-1', token: { phone_number: FROM } } };
const OTHER_AUTH = { auth: { uid: 'user-2', token: { phone_number: OTHER } } };

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 9, 3, 12) }); // Oct 3 2026: "last month" is September
  fake = createFakeFirestore();
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
  admin.firestore.Timestamp = fake.db.Timestamp;
  sendSms.mockReset();
  sendSms.mockResolvedValue();
});
afterEach(() => jest.useRealTimers());

function seed(id, data) {
  const map = fake.store.receipts || (fake.store.receipts = new Map());
  map.set(id, { from: FROM, createdAt: fake.db.Timestamp.fromMillis(Date.now()), ...data });
}

function seedMixedMonth() {
  seed('a', { date: '2026-09-02', total: 50, merchant: 'Costco', category: 'Grocery', items: [{ name: 'Milk', price: 30 }, { name: 'Soap', price: 15, category: 'Household' }] });
  seed('b', { date: '2026-09-15', total: 20.1, merchant: 'costco', category: 'Grocery' });
  seed('c', { date: '2026-09-30', total: 12.34, merchant: 'Shoppers', category: 'Health', currency: 'CAD' });
  seed('d', { date: '2026-09-10', total: 45, merchant: 'Target', category: 'Shopping', currency: 'USD' });
  seed('e', { date: '2026-09-11', total: 30, merchant: 'Fnac', category: 'Home', currency: 'EUR' });
  seed('f', { date: null, total: 99, merchant: 'No date', category: 'Other' });
  seed('g', { date: '2026-10-01', total: 70, merchant: 'Next month', category: 'Grocery' });
  seed('h', { date: '2026-08-31', total: 10, merchant: 'Metro', category: 'Grocery' });
  seed('i', { date: '2026-08-05', total: 25, merchant: 'Shoppers', category: 'Health' });
  seed('x', { from: OTHER, date: '2026-09-05', total: 1000, merchant: 'Someone else', category: 'Grocery' });
}

describe('getMonthlyRecap', () => {
  it('rejects unauthenticated callers', async () => {
    await expect(getMonthlyRecap({ auth: null, data: { month: '2026-09' } })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it.each([[undefined], [''], ['2026-9'], ['2026-13'], ['2026-00'], ['26-09'], ['2026-09-01'], [202609], [{ month: '2026-09' }], ['2026-09 ']])(
    'rejects a bad month %p as invalid-argument', async (month) => {
      await expect(getMonthlyRecap({ ...AUTH, data: { month } })).rejects.toMatchObject({ code: 'invalid-argument' });
    });

  it('gives the same total, count, categories and other currencies as the monthly recap', async () => {
    seedMixedMonth();
    await sendMonthlyDigest(FROM);
    const notification = [...fake.store.notifications.values()][0];
    expect(notification.monthKey).toBe('2026-09');

    const recap = await getMonthlyRecap({ ...AUTH, data: { month: notification.monthKey } });
    expect(recap.total).toBe(notification.total);
    expect(recap.count).toBe(notification.count);
    expect(recap.categories).toEqual(notification.categories);
    expect(recap.byCurrency).toEqual(notification.byCurrency);
    expect(recap.month).toBe(notification.month);
    expect(sendSms.mock.calls[0][1]).toContain(`$${recap.total.toFixed(2)} across ${recap.count} receipts`);

    expect(recap.total).toBe(82.44);
    expect(recap.categories).toEqual({ Grocery: 55.1, Household: 15, Health: 12.34 });
    expect(Object.keys(recap.byCurrency).sort()).toEqual(['EUR', 'USD']);
  });

  it('includes the previous month for comparison', async () => {
    seedMixedMonth();
    const recap = await getMonthlyRecap({ ...AUTH, data: { month: '2026-09' } });
    expect(recap.previous).toMatchObject({ monthKey: '2026-08', month: 'August', year: 2026, total: 35, count: 2, categories: { Grocery: 10, Health: 25 } });
    expect(recap.previous.docs).toBeUndefined();
  });

  it('lists top stores by CAD spend, merging merchant name case, and skips other currencies', async () => {
    seedMixedMonth();
    const { topMerchants } = await getMonthlyRecap({ ...AUTH, data: { month: '2026-09' } });
    expect(topMerchants).toEqual([
      { name: 'Costco', total: 70.1, count: 2 },
      { name: 'Shoppers', total: 12.34, count: 1 },
    ]);
  });

  it('caps top stores at five', async () => {
    for (let i = 0; i < 8; i += 1) seed(`s${i}`, { date: '2026-09-05', total: 10 + i, merchant: `Store ${i}`, category: 'Other' });
    const { topMerchants } = await getMonthlyRecap({ ...AUTH, data: { month: '2026-09' } });
    expect(topMerchants.map((m) => m.name)).toEqual(['Store 7', 'Store 6', 'Store 5', 'Store 4', 'Store 3']);
  });

  it("returns only the caller's receipts for that month, newest first, including other currencies", async () => {
    seedMixedMonth();
    const recap = await getMonthlyRecap({ ...AUTH, data: { month: '2026-09' } });
    expect(recap.receipts.map((r) => r.id)).toEqual(['c', 'b', 'e', 'd', 'a']);
    expect(recap.receipts[4].items).toHaveLength(2);
    expect(JSON.stringify(recap)).not.toContain('Someone else');

    const other = await getMonthlyRecap({ ...OTHER_AUTH, data: { month: '2026-09' } });
    expect(other.total).toBe(1000);
    expect(other.receipts.map((r) => r.id)).toEqual(['x']);
  });

  it('returns an empty month without failing', async () => {
    const recap = await getMonthlyRecap({ ...AUTH, data: { month: '2025-02' } });
    expect(recap).toMatchObject({ total: 0, count: 0, categories: {}, topMerchants: [], receipts: [], previous: { monthKey: '2025-01', total: 0 } });
    expect(recap.byCurrency).toBeUndefined();
  });

  it('compares January with the December before it', async () => {
    seed('dec', { date: '2025-12-20', total: 40, merchant: 'Metro', category: 'Grocery' });
    seed('jan', { date: '2026-01-04', total: 15, merchant: 'Metro', category: 'Grocery' });
    const recap = await getMonthlyRecap({ ...AUTH, data: { month: '2026-01' } });
    expect(recap.total).toBe(15);
    expect(recap.previous).toMatchObject({ monthKey: '2025-12', month: 'December', year: 2025, total: 40 });
  });
});

describe('SUMMARY text reply', () => {
  it('matches the recap page for the current month when receipts were sent in the month printed on them', async () => {
    jest.setSystemTime(new Date(2026, 9, 20, 12));
    const sent = (day) => fake.db.Timestamp.fromMillis(new Date(2026, 9, day, 12).getTime());
    seed('o1', { date: '2026-10-02', createdAt: sent(2), total: 30, merchant: 'Metro', category: 'Grocery', items: [{ name: 'Bread', price: 4 }, { name: 'Aspirin', price: 9, category: 'Health' }] });
    seed('o2', { date: '2026-10-11', createdAt: sent(11), total: 18.5, merchant: 'Presto', category: 'Transportation' });
    seed('o3', { date: '2026-10-12', createdAt: sent(12), total: 45, merchant: 'Target', category: 'Shopping', currency: 'USD' });
    seed('s', { date: '2026-09-28', createdAt: fake.db.Timestamp.fromMillis(new Date(2026, 8, 28, 12).getTime()), total: 99, merchant: 'Old', category: 'Grocery' });

    const summary = await getMonthlyStats(FROM);
    const recap = await getMonthlyRecap({ ...AUTH, data: { month: '2026-10' } });
    expect(recap.total).toBe(summary.total);
    expect(recap.count).toBe(summary.count);
    expect(recap.categories).toEqual(summary.categories);
    expect(recap.byCurrency).toEqual(summary.byCurrency);
    expect(recap.total).toBe(48.5);
  });
});

describe('month helpers', () => {
  it('shifts across year boundaries', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2025-12', 1)).toBe('2026-01');
    expect(shiftMonthKey('2026-09', -1)).toBe('2026-08');
  });
  it('accepts only YYYY-MM', () => {
    expect(isMonthKey('2026-09')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
  });
});
