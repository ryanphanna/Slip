const { createFakeFirestore } = require('../test-helpers/fake-firestore');

let fake;
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));

const admin = require('firebase-admin');
const { saveReceipt, saveProcessingFailure, findDuplicate, isMessageProcessed, checkRateLimit } = require('../lib/store');

beforeEach(() => {
  fake = createFakeFirestore();
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
});

describe('saveReceipt', () => {
  it('normalizes merchantKey and stores expected fields', async () => {
    const id = await saveReceipt({ merchant: 'Metro ', total: 12.5 }, '+1', 'sid-1', ['path/a.jpg']);
    const doc = await fake.db.collection('receipts').doc(id).get();
    expect(doc.data()).toMatchObject({
      merchant: 'Metro ', merchantKey: 'metro', from: '+1', messageSid: 'sid-1', imagePaths: ['path/a.jpg'],
    });
    expect(doc.data().createdAt.toDate()).toBeInstanceOf(Date);
  });

  it('stores a null merchantKey when merchant is missing', async () => {
    const id = await saveReceipt({ total: 5 }, '+1', null);
    const doc = await fake.db.collection('receipts').doc(id).get();
    expect(doc.data().merchantKey).toBeNull();
    expect(doc.data().messageSid).toBeNull();
  });
});

describe('saveProcessingFailure', () => {
  it('keys the failure doc by messageSid when provided', async () => {
    const id = await saveProcessingFailure({ from: '+1', messageSid: 'sid-9', error: 'boom' });
    expect(id).toBe('sid-9');
    const doc = await fake.db.collection('processing_failures').doc('sid-9').get();
    expect(doc.data()).toMatchObject({ from: '+1', status: 'failed', error: 'boom' });
  });

  it('auto-generates an id when there is no messageSid', async () => {
    const id = await saveProcessingFailure({ from: '+1', error: 'boom' });
    const doc = await fake.db.collection('processing_failures').doc(id).get();
    expect(doc.exists).toBe(true);
    expect(doc.data().error).toBe('boom');
  });

  it('defaults the error message when none is given', async () => {
    const id = await saveProcessingFailure({ from: '+1', messageSid: 'sid-2' });
    const doc = await fake.db.collection('processing_failures').doc(id).get();
    expect(doc.data().error).toBe('Unknown receipt processing error');
  });
});

describe('isMessageProcessed', () => {
  it('returns false for an empty/missing messageSid without querying', async () => {
    expect(await isMessageProcessed(null)).toBe(false);
    expect(await isMessageProcessed('')).toBe(false);
  });

  it('returns true once a receipt with that messageSid exists', async () => {
    await saveReceipt({ merchant: 'Metro', total: 1 }, '+1', 'sid-5');
    expect(await isMessageProcessed('sid-5')).toBe(true);
    expect(await isMessageProcessed('sid-unknown')).toBe(false);
  });
});

describe('findDuplicate', () => {
  it('returns null when merchant or total is missing', async () => {
    expect(await findDuplicate({ merchant: null, total: 5 }, '+1')).toBeNull();
    expect(await findDuplicate({ merchant: 'Metro', total: null }, '+1')).toBeNull();
  });

  it('catches a rapid re-send within the duplicate window', async () => {
    const id = await saveReceipt({ merchant: 'Metro', total: 12.5 }, '+1', 'sid-1');
    const found = await findDuplicate({ merchant: 'Metro', total: 12.5 }, '+1');
    expect(found).toBe(id);
  });

  it('does not flag the same merchant/total for a different sender', async () => {
    await saveReceipt({ merchant: 'Metro', total: 12.5 }, '+1', 'sid-1');
    expect(await findDuplicate({ merchant: 'Metro', total: 12.5 }, '+2')).toBeNull();
  });

  it('catches a same-day-old-receipt re-upload by matching date instead of the time window', async () => {
    const map = fake.store.receipts || (fake.store.receipts = new Map());
    map.set('old-1', {
      merchant: 'Metro', merchantKey: 'metro', total: 12.5, date: '2025-01-01', from: '+1',
      createdAt: { toDate: () => new Date('2020-01-01'), toMillis: () => 0 },
    });
    const found = await findDuplicate({ merchant: 'Metro', total: 12.5, date: '2025-01-01' }, '+1');
    expect(found).toBe('old-1');
  });

  it('returns null when nothing matches', async () => {
    expect(await findDuplicate({ merchant: 'Costco', total: 99 }, '+1')).toBeNull();
  });
});

describe('checkRateLimit', () => {
  function seedReceipt(from, createdAtDate) {
    const map = fake.store.receipts || (fake.store.receipts = new Map());
    map.set(`r-${map.size}`, { from, createdAt: { toDate: () => createdAtDate, toMillis: () => createdAtDate.getTime() } });
  }

  it('allows a sender under both limits', async () => {
    seedReceipt('+1', new Date());
    expect(await checkRateLimit('+1')).toEqual({ exceeded: false });
  });

  it('flags hourly limit before daily limit when only recent receipts exist', async () => {
    for (let i = 0; i < 25; i++) seedReceipt('+1', new Date());
    expect(await checkRateLimit('+1')).toEqual({ exceeded: true, reason: 'hourly' });
  });

  it('flags the daily limit once total receipts in 24h exceed it, even if older than an hour', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (let i = 0; i < 100; i++) seedReceipt('+1', twoHoursAgo);
    expect(await checkRateLimit('+1')).toEqual({ exceeded: true, reason: 'daily' });
  });
});
