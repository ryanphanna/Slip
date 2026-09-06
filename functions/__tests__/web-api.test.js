const { createFakeFirestore } = require('../test-helpers/fake-firestore');

let fake;
let storageFiles;

jest.mock('firebase-admin', () => ({ firestore: jest.fn(), storage: jest.fn() }));
jest.mock('../lib/receipt', () => ({ parseReceiptFromBase64: jest.fn() }));

const admin = require('firebase-admin');
const { parseReceiptFromBase64 } = require('../lib/receipt');
const {
  cleanPatch, requireAuth, EDITABLE_FIELDS, VISIBLE_FAILURE_STATUSES,
  listReceipts, getReceipt, updateReceipt, listProcessingFailures, listNotifications,
  retryProcessing, importTargetReceipts, listItems, updateItem,
  getUserSettings, updateUserSettings,
} = require('../lib/web-api');

const AUTH = { auth: { uid: 'user-1', token: { phone_number: '+14165551234' } } };

function fakeBucket() {
  return {
    file: (path) => ({
      download: async () => [Buffer.from(storageFiles[path]?.content || 'img')],
      getMetadata: async () => [{ contentType: storageFiles[path]?.contentType || 'image/jpeg' }],
    }),
  };
}

beforeEach(() => {
  fake = createFakeFirestore();
  storageFiles = {};
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
  admin.firestore.Timestamp = fake.db.Timestamp;
  admin.storage.mockReturnValue({ bucket: fakeBucket });
  parseReceiptFromBase64.mockReset();
});

function seed(collection, id, data) {
  const map = fake.store[collection] || (fake.store[collection] = new Map());
  map.set(id, data);
}

describe('web API helpers', () => {
  it('keeps only editable receipt fields', () => {
    expect(cleanPatch({ merchant: 'Costco', total: 12.5, from: '+1', createdAt: 'bad', items: [] }))
      .toEqual({ merchant: 'Costco', total: 12.5, items: [] });
    expect(EDITABLE_FIELDS.has('imagePaths')).toBe(false);
  });

  it('requires a signed-in phone identity', () => {
    expect(() => requireAuth({ auth: null })).toThrow('Authentication required');
    expect(requireAuth(AUTH)).toEqual({ uid: 'user-1', phone: '+14165551234' });
  });

  it('keeps retryable and previously reviewed processing records available', () => {
    expect(VISIBLE_FAILURE_STATUSES.has('failed')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('pending')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('resolved')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('duplicate')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('recovered')).toBe(false);
  });
});

describe('listReceipts', () => {
  it('rejects unauthenticated requests', async () => {
    await expect(listReceipts({ auth: null, data: {} })).rejects.toThrow('Authentication required');
  });

  it('only returns receipts belonging to the caller phone number', async () => {
    seed('receipts', 'mine', { from: '+14165551234', createdAt: fake.db.Timestamp.fromMillis(2) });
    seed('receipts', 'theirs', { from: '+19999999999', createdAt: fake.db.Timestamp.fromMillis(1) });
    const result = await listReceipts({ ...AUTH, data: {} });
    expect(result.receipts.map((r) => r.id)).toEqual(['mine']);
  });

  it('reports hasMore and a cursor when more receipts exist than the limit', async () => {
    for (let i = 0; i < 3; i++) {
      seed('receipts', `r${i}`, { from: '+14165551234', createdAt: fake.db.Timestamp.fromMillis(i) });
    }
    const result = await listReceipts({ ...AUTH, data: { limit: 2 } });
    expect(result.receipts).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(result.receipts.at(-1).createdAt.toMillis());
  });

  it('does not report hasMore when everything fits under the limit', async () => {
    seed('receipts', 'r0', { from: '+14165551234', createdAt: fake.db.Timestamp.fromMillis(1) });
    const result = await listReceipts({ ...AUTH, data: { limit: 25 } });
    expect(result.hasMore).toBe(false);
  });
});

describe('getReceipt / updateReceipt', () => {
  it('throws not-found for a receipt owned by a different phone number', async () => {
    seed('receipts', 'r1', { from: '+19999999999', merchant: 'Costco' });
    await expect(getReceipt({ ...AUTH, data: { id: 'r1' } })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('returns the receipt when it belongs to the caller', async () => {
    seed('receipts', 'r1', { from: '+14165551234', merchant: 'Costco' });
    const result = await getReceipt({ ...AUTH, data: { id: 'r1' } });
    expect(result).toMatchObject({ id: 'r1', merchant: 'Costco' });
  });

  it('rejects edits to a receipt owned by a different phone number', async () => {
    seed('receipts', 'r1', { from: '+19999999999', merchant: 'Costco', total: 5 });
    await expect(updateReceipt({ ...AUTH, data: { id: 'r1', patch: { total: 99 } } }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('only applies editable fields, dropping anything else in the patch', async () => {
    seed('receipts', 'r1', { from: '+14165551234', merchant: 'Costco', total: 5, category: 'Grocery', items: [] });
    const result = await updateReceipt({
      ...AUTH,
      data: { id: 'r1', patch: { total: 99, from: '+19999999999', imagePaths: ['x'] } },
    });
    expect(result.total).toBe(99);
    const stored = await fake.db.collection('receipts').doc('r1').get();
    expect(stored.data().from).toBe('+14165551234');
  });
});

describe('listProcessingFailures', () => {
  it('filters out recovered failures and failures with no stored image', async () => {
    seed('processing_failures', 'a', { from: '+14165551234', status: 'failed', imagePaths: ['p'], createdAt: fake.db.Timestamp.fromMillis(2) });
    seed('processing_failures', 'b', { from: '+14165551234', status: 'recovered', imagePaths: ['p'], createdAt: fake.db.Timestamp.fromMillis(3) });
    seed('processing_failures', 'c', { from: '+14165551234', status: 'failed', imagePaths: [], createdAt: fake.db.Timestamp.fromMillis(4) });
    seed('processing_failures', 'd', { from: '+19999999999', status: 'failed', imagePaths: ['p'], createdAt: fake.db.Timestamp.fromMillis(5) });
    const { failures } = await listProcessingFailures({ ...AUTH, data: {} });
    expect(failures.map((f) => f.id)).toEqual(['a']);
  });

  it('sorts remaining failures newest first', async () => {
    seed('processing_failures', 'old', { from: '+14165551234', status: 'failed', imagePaths: ['p'], createdAt: fake.db.Timestamp.fromMillis(1) });
    seed('processing_failures', 'new', { from: '+14165551234', status: 'failed', imagePaths: ['p'], createdAt: fake.db.Timestamp.fromMillis(2) });
    const { failures } = await listProcessingFailures({ ...AUTH, data: {} });
    expect(failures.map((f) => f.id)).toEqual(['new', 'old']);
  });
});

describe('listNotifications', () => {
  it('only returns notifications for the caller', async () => {
    seed('notifications', 'a', { from: '+14165551234', createdAt: fake.db.Timestamp.fromMillis(1) });
    seed('notifications', 'b', { from: '+19999999999', createdAt: fake.db.Timestamp.fromMillis(2) });
    const { notifications } = await listNotifications({ ...AUTH, data: {} });
    expect(notifications.map((n) => n.id)).toEqual(['a']);
  });
});

describe('retryProcessing', () => {
  it('throws not-found for a failure owned by a different phone number', async () => {
    seed('processing_failures', 'f1', { from: '+19999999999', imagePaths: ['p'] });
    await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses to retry a failure with no stored image', async () => {
    seed('processing_failures', 'f1', { from: '+14165551234', imagePaths: [] });
    await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toThrow('no stored image');
  });

  it('re-parses the stored image and marks the failure recovered', async () => {
    storageFiles['path/a.jpg'] = { content: 'img', contentType: 'image/jpeg' };
    seed('processing_failures', 'f1', { from: '+14165551234', imagePaths: ['path/a.jpg'], messageSid: 'sid-1' });
    parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 12.5, confidence: 0.9, items: [] });

    const result = await retryProcessing({ ...AUTH, data: { id: 'f1' } });
    expect(result.merchant).toBe('Costco');
    expect(result.confidence).toBe(0.9);

    const failure = await fake.db.collection('processing_failures').doc('f1').get();
    expect(failure.data().status).toBe('recovered');
    expect(failure.data().recoveredReceiptId).toBe(result.id);

    const receipt = await fake.db.collection('receipts').doc(result.id).get();
    expect(receipt.data().recoveredFromFailure).toBe('f1');
  });
});

describe('importTargetReceipts', () => {
  const validRecord = { merchant: 'Target', sourceOrderId: 'ord-1', total: 10, date: '2026-01-01', items: [{ name: 'Widget', price: 10 }] };

  it('rejects an empty or oversized batch', async () => {
    await expect(importTargetReceipts({ ...AUTH, data: { receipts: [] } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(importTargetReceipts({ ...AUTH, data: { receipts: Array(101).fill(validRecord) } })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a record that is not a Target receipt with a sourceOrderId', async () => {
    await expect(importTargetReceipts({ ...AUTH, data: { receipts: [{ merchant: 'Costco', sourceOrderId: 'x' }] } }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(importTargetReceipts({ ...AUTH, data: { receipts: [{ merchant: 'Target' }] } }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('imports a new record and writes its items', async () => {
    const { imported, skipped } = await importTargetReceipts({ ...AUTH, data: { receipts: [validRecord] } });
    expect(skipped).toEqual([]);
    expect(imported).toEqual([{ sourceOrderId: 'ord-1', id: expect.any(String) }]);
    const receipt = await fake.db.collection('receipts').doc(imported[0].id).get();
    expect(receipt.data()).toMatchObject({ merchant: 'Target', source: 'target', sourceOrderId: 'ord-1' });
  });

  it('updates rather than duplicates a record with the same sourceOrderId', async () => {
    const first = await importTargetReceipts({ ...AUTH, data: { receipts: [validRecord] } });
    const second = await importTargetReceipts({ ...AUTH, data: { receipts: [{ ...validRecord, total: 20 }] } });
    expect(second.imported).toEqual([]);
    expect(second.skipped).toEqual([{ sourceOrderId: 'ord-1', id: first.imported[0].id, updated: true }]);
    const receipt = await fake.db.collection('receipts').doc(first.imported[0].id).get();
    expect(receipt.data().total).toBe(20);
  });
});

describe('listItems / updateItem', () => {
  it('only returns items belonging to the caller', async () => {
    seed('items', 'a', { from: '+14165551234', updatedAt: fake.db.Timestamp.fromMillis(1) });
    seed('items', 'b', { from: '+19999999999', updatedAt: fake.db.Timestamp.fromMillis(2) });
    const { items } = await listItems({ ...AUTH, data: {} });
    expect(items.map((i) => i.id)).toEqual(['a']);
  });

  it('throws not-found for an item owned by a different phone number', async () => {
    seed('items', 'a', { from: '+19999999999' });
    await expect(updateItem({ ...AUTH, data: { id: 'a', patch: { publicName: 'x' } } })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('trims allowed string fields and drops disallowed ones', async () => {
    seed('items', 'a', { from: '+14165551234', publicName: 'old' });
    const result = await updateItem({ ...AUTH, data: { id: 'a', patch: { publicName: '  New Name  ', from: '+19999999999' } } });
    expect(result.publicName).toBe('New Name');
    const stored = await fake.db.collection('items').doc('a').get();
    expect(stored.data().from).toBe('+14165551234');
  });
});

describe('user settings', () => {
  it('returns defaults when no settings doc exists, and persists updates', async () => {
    const defaults = await getUserSettings(AUTH);
    expect(defaults).toEqual({ monthlyDigestEnabled: true });

    await updateUserSettings({ ...AUTH, data: { patch: { monthlyDigestEnabled: false } } });
    const updated = await getUserSettings(AUTH);
    expect(updated.monthlyDigestEnabled).toBe(false);
  });
});
