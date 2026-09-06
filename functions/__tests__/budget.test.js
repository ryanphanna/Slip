const { createFakeFirestore } = require('../test-helpers/fake-firestore');

let fake;
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));

const admin = require('firebase-admin');
const { setBudget, getBudget, getAllBudgets, getBudgetReport } = require('../lib/budget');

beforeEach(() => {
  fake = createFakeFirestore();
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
});

function seedReceipt(id, data) {
  const map = fake.store.receipts || (fake.store.receipts = new Map());
  map.set(id, { createdAt: fake.db.Timestamp.fromMillis(Date.now()), ...data });
}

describe('setBudget / getBudget / getAllBudgets', () => {
  it('stores a trimmed category and floors a negative limit to zero', async () => {
    const result = await setBudget('+1', '  Grocery  ', -5);
    expect(result).toEqual({ category: 'Grocery', limit: 0 });
    const stored = await getBudget('+1', '  Grocery  ');
    expect(stored).toMatchObject({ from: '+1', category: 'Grocery', limit: 0 });
  });

  it('returns null for a budget that was never set', async () => {
    expect(await getBudget('+1', 'Health')).toBeNull();
  });

  it('only returns budgets belonging to the given sender', async () => {
    await setBudget('+1', 'Grocery', 200);
    await setBudget('+2', 'Grocery', 999);
    const budgets = await getAllBudgets('+1');
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ from: '+1', limit: 200 });
  });

  it('treats a non-numeric limit as zero', async () => {
    const result = await setBudget('+1', 'Grocery', 'not-a-number');
    expect(result.limit).toBe(0);
  });
});

describe('getBudgetReport', () => {
  it('reports spend, remaining, and percentage for a budgeted category', async () => {
    await setBudget('+1', 'Grocery', 200);
    seedReceipt('r1', { from: '+1', total: 50, category: 'Grocery' });
    const report = await getBudgetReport('+1');
    expect(report).toEqual([{ category: 'Grocery', limit: 200, spent: 50, remaining: 150, percentage: 25 }]);
  });

  it('matches spend to a budget category case-insensitively', async () => {
    await setBudget('+1', 'grocery', 100);
    seedReceipt('r1', { from: '+1', total: 40, category: 'Grocery' });
    const report = await getBudgetReport('+1');
    expect(report[0]).toMatchObject({ spent: 40, remaining: 60 });
  });

  it('reports zero spend for a budget with no matching receipts this month', async () => {
    await setBudget('+1', 'Health', 100);
    const report = await getBudgetReport('+1');
    expect(report[0]).toEqual({ category: 'Health', limit: 100, spent: 0, remaining: 100, percentage: 0 });
  });

  it('lists spending in an unbudgeted category with a negative remaining and zero limit', async () => {
    seedReceipt('r1', { from: '+1', total: 30, category: 'Entertainment' });
    const report = await getBudgetReport('+1');
    expect(report).toEqual([{ category: 'Entertainment', limit: 0, spent: 30, remaining: -30, percentage: 0 }]);
  });

  it('does not divide by zero when a budget limit is zero but has spend', async () => {
    await setBudget('+1', 'Grocery', 0);
    seedReceipt('r1', { from: '+1', total: 10, category: 'Grocery' });
    const report = await getBudgetReport('+1');
    expect(report[0].percentage).toBe(0);
  });

  it('excludes receipts from before the start of this month', async () => {
    await setBudget('+1', 'Grocery', 100);
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    seedReceipt('old', { from: '+1', total: 999, category: 'Grocery', createdAt: fake.db.Timestamp.fromMillis(lastMonth.getTime()) });
    const report = await getBudgetReport('+1');
    expect(report[0].spent).toBe(0);
  });
});
