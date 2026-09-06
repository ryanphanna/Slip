const { createFakeFirestore } = require('../test-helpers/fake-firestore');

let fake;
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
jest.mock('../lib/twilio', () => ({ sendSms: jest.fn() }));

const admin = require('firebase-admin');
const { sendSms } = require('../lib/twilio');
const { setBudget } = require('../lib/budget');
const { sendMonthlyDigest, sendWeeklyBudgetCheck } = require('../lib/digest');

const FROM = '+14165551234';

beforeEach(() => {
  fake = createFakeFirestore();
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
  sendSms.mockReset();
  sendSms.mockResolvedValue();
});

function seedReceipt(id, data) {
  const map = fake.store.receipts || (fake.store.receipts = new Map());
  map.set(id, { from: FROM, createdAt: fake.db.Timestamp.fromMillis(Date.now()), ...data });
}

function lastMonthDateString(day = '15') {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-${day}`;
}

describe('sendMonthlyDigest', () => {
  it('sends nothing when the user has disabled the monthly digest', async () => {
    const map = fake.store.settings || (fake.store.settings = new Map());
    map.set(FROM.replace(/[^a-zA-Z0-9]/g, ''), { monthlyDigestEnabled: false });
    seedReceipt('r1', { date: lastMonthDateString(), total: 10, category: 'Grocery' });
    await sendMonthlyDigest(FROM);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('sends nothing when there were no receipts last month', async () => {
    await sendMonthlyDigest(FROM);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('sends a recap sorted by spend and records the notification once', async () => {
    seedReceipt('r1', { date: lastMonthDateString('01'), total: 10, category: 'Health' });
    seedReceipt('r2', { date: lastMonthDateString('02'), total: 40, category: 'Grocery' });

    await sendMonthlyDigest(FROM);

    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, message] = sendSms.mock.calls[0];
    expect(to).toBe(FROM);
    expect(message).toContain('$50.00 across 2 receipts');
    // Grocery (higher spend) should be listed before Health
    expect(message.indexOf('Grocery')).toBeLessThan(message.indexOf('Health'));

    // Second call for the same month should be a no-op (already notified)
    sendSms.mockClear();
    await sendMonthlyDigest(FROM);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('uses singular "receipt" wording for exactly one receipt', async () => {
    seedReceipt('r1', { date: lastMonthDateString(), total: 10, category: 'Grocery' });
    await sendMonthlyDigest(FROM);
    expect(sendSms.mock.calls[0][1]).toContain('1 receipt\n');
  });
});

describe('sendWeeklyBudgetCheck', () => {
  it('sends nothing when the user has no budgets set', async () => {
    await sendWeeklyBudgetCheck(FROM);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('flags an over-budget category ahead of a near-limit one, in one message', async () => {
    await setBudget(FROM, 'Grocery', 100);
    await setBudget(FROM, 'Shopping', 100);
    await setBudget(FROM, 'Health', 100);
    seedReceipt('r1', { total: 120, category: 'Grocery' });   // over budget
    seedReceipt('r2', { total: 85, category: 'Shopping' });   // near limit (>=80%)
    seedReceipt('r3', { total: 10, category: 'Health' });     // well under

    await sendWeeklyBudgetCheck(FROM);

    const message = sendSms.mock.calls[0][1];
    expect(message.indexOf('Grocery')).toBeLessThan(message.indexOf('Shopping'));
    expect(message.indexOf('Shopping')).toBeLessThan(message.indexOf('Health'));
    expect(message).toContain('⚠️ Grocery');
    expect(message).toContain('🔶 Shopping');
  });

  it('does not divide by zero for a zero-limit budget', async () => {
    await setBudget(FROM, 'Grocery', 0);
    seedReceipt('r1', { total: 10, category: 'Grocery' });
    await sendWeeklyBudgetCheck(FROM);
    expect(sendSms.mock.calls[0][1]).toContain('(0%)');
  });
});
