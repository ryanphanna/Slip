const { createFakeFirestore, makeTimestamp } = require('../test-helpers/fake-firestore');

jest.mock('firebase-admin', () => ({ firestore: jest.fn(), storage: jest.fn() }));
jest.mock('../lib/receipt', () => ({ parseReceiptFromBase64: jest.fn(), parseReceiptFromText: jest.fn(), photoReadNothing: (raw) => !raw || (raw.merchant == null && raw.total == null && (!Array.isArray(raw.items) || raw.items.length === 0)), groupReceiptPhotos: jest.fn(async (images) => [images.map((_, i) => i)]) }));

process.env.ALLOWED_PHONES = '+14165551234,+14165559999';

const admin = require('firebase-admin');
const webApi = require('../lib/web-api');

const ME = { auth: { uid: 'me', token: { phone_number: '+14165551234' } } };
const OTHER_DATA = '+14165559999'; // another allowed account whose data must stay invisible
let fake;
let files;

beforeEach(() => {
  fake = createFakeFirestore();
  files = {};
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
  admin.firestore.Timestamp = fake.db.Timestamp;
  admin.storage.mockReturnValue({
    bucket: () => ({
      file: (path) => ({
        download: async () => {
          if (files[path] === undefined) throw new Error('No such object');
          return [Buffer.from(files[path])];
        },
        getMetadata: async () => [{ contentType: 'image/png' }],
      }),
    }),
  });
});

const seed = (collection, id, data) => {
  (fake.store[collection] || (fake.store[collection] = new Map())).set(id, data);
};

const HANDLERS = Object.entries(webApi).filter(([name, fn]) => typeof fn === 'function' && !['requireAuth', 'cleanPatch'].includes(name));

describe('authentication', () => {
  it.each(HANDLERS.map(([name]) => [name]))('%s rejects requests with no auth', async (name) => {
    await expect(webApi[name]({ data: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it.each(HANDLERS.map(([name]) => [name]))('%s rejects a token that has a uid but no phone number', async (name) => {
    await expect(webApi[name]({ auth: { uid: 'x', token: {} }, data: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a phone number that is not an exact allowlist match', async () => {
    await expect(webApi.listReceipts({ auth: { uid: 'x', token: { phone_number: '+1416555123' } }, data: {} }))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe("other accounts' data", () => {
  beforeEach(() => {
    seed('receipts', 'theirs', { from: OTHER_DATA, merchant: 'Secret', total: 9, imagePaths: ['theirs.png'], createdAt: makeTimestamp(new Date()) });
    seed('processing_failures', 'theirs', { from: OTHER_DATA, imagePaths: ['theirs.png'], status: 'failed' });
    seed('items', 'theirs', { from: OTHER_DATA, name: 'Secret item' });
    files['theirs.png'] = 'secret-bytes';
  });

  it('getReceipt, updateReceipt and getReceiptImageUrls report not-found, not forbidden (no existence leak)', async () => {
    await expect(webApi.getReceipt({ ...ME, data: { id: 'theirs' } })).rejects.toMatchObject({ code: 'not-found', message: 'Receipt not found' });
    await expect(webApi.updateReceipt({ ...ME, data: { id: 'theirs', patch: { merchant: 'Hacked' } } })).rejects.toMatchObject({ code: 'not-found' });
    await expect(webApi.getReceiptImageUrls({ ...ME, data: { id: 'theirs' } })).rejects.toMatchObject({ code: 'not-found' });
    await expect(webApi.getReceipt({ ...ME, data: { id: 'does-not-exist' } })).rejects.toMatchObject({ code: 'not-found', message: 'Receipt not found' });
    expect(fake.store.receipts.get('theirs').merchant).toBe('Secret');
  });

  it('failure image urls, retries and item edits are refused for another account', async () => {
    await expect(webApi.getProcessingFailureImageUrls({ ...ME, data: { id: 'theirs' } })).rejects.toMatchObject({ code: 'not-found' });
    await expect(webApi.retryProcessing({ ...ME, data: { id: 'theirs' } })).rejects.toMatchObject({ code: 'not-found' });
    await expect(webApi.updateItem({ ...ME, data: { id: 'theirs', patch: { name: 'Hacked' } } })).rejects.toMatchObject({ code: 'not-found' });
    expect(fake.store.items.get('theirs').name).toBe('Secret item');
    expect(fake.store.processing_failures.get('theirs').status).toBe('failed');
  });

  it('list endpoints never include another account\'s records', async () => {
    expect((await webApi.listReceipts({ ...ME, data: {} })).receipts).toEqual([]);
    expect((await webApi.listProcessingFailures({ ...ME })).failures).toEqual([]);
    expect((await webApi.listItems({ ...ME })).items).toEqual([]);
    expect((await webApi.listNotifications({ ...ME })).notifications).toEqual([]);
  });

  it('a user cannot revoke or see another account\'s import tokens', async () => {
    const theirs = { auth: { uid: 'u9', token: { phone_number: OTHER_DATA } } };
    const created = await webApi.createImportToken({ ...theirs, data: { label: 'theirs' } });
    expect((await webApi.listImportTokens(ME)).tokens).toEqual([]);
    await expect(webApi.revokeImportToken({ ...ME, data: { id: created.id } })).rejects.toMatchObject({ code: 'not-found' });
    expect((await webApi.listImportTokens(theirs)).tokens[0].revoked).toBe(false);
  });
});

describe('bad input', () => {
  it('requires an id for receipt, failure and item operations', async () => {
    await expect(webApi.getReceipt({ ...ME, data: {} })).rejects.toThrow('Receipt id is required');
    await expect(webApi.updateReceipt({ ...ME, data: { patch: {} } })).rejects.toThrow('Receipt id is required');
    await expect(webApi.updateItem({ ...ME, data: { id: '   ' } })).rejects.toThrow('Item id is required');
    await expect(webApi.retryProcessing({ ...ME, data: {} })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('missing data object is handled like empty input (no crash)', async () => {
    await expect(webApi.getReceipt({ ...ME })).rejects.toThrow('Receipt id is required');
    await expect(webApi.listReceipts({ ...ME })).resolves.toMatchObject({ receipts: [] });
  });

  it('clamps the page size to 1..100 and tolerates a nonsense limit', async () => {
    for (let i = 0; i < 120; i++) {
      seed('receipts', `r${i}`, { from: '+14165551234', merchant: `m${i}`, createdAt: makeTimestamp(new Date(1000000 + i)) });
    }
    expect((await webApi.listReceipts({ ...ME, data: { limit: 100000 } })).receipts).toHaveLength(100);
    expect((await webApi.listReceipts({ ...ME, data: { limit: -5 } })).receipts).toHaveLength(1);
    expect((await webApi.listReceipts({ ...ME, data: { limit: 'abc' } })).receipts).toHaveLength(25);
    expect((await webApi.listReceipts({ ...ME, data: { limit: 0 } })).receipts).toHaveLength(25);
  });

  it('rejects a non-boolean monthlyDigestEnabled and a missing patch', async () => {
    await expect(webApi.updateUserSettings({ ...ME, data: { patch: { monthlyDigestEnabled: 'yes' } } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(webApi.updateUserSettings({ ...ME, data: {} })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(fake.store.settings?.size || 0).toBe(0);
  });

  it('updateReceipt on a missing receipt is not-found, and an empty patch changes nothing but editedAt', async () => {
    await expect(webApi.updateReceipt({ ...ME, data: { id: 'nope', patch: { merchant: 'x' } } })).rejects.toMatchObject({ code: 'not-found' });
    seed('receipts', 'mine', { from: '+14165551234', merchant: 'Costco', merchantKey: 'costco', total: 5, category: 'Grocery', items: [] });
    await webApi.updateReceipt({ ...ME, data: { id: 'mine', patch: { from: OTHER_DATA, imagePaths: ['x'], createdAt: 1 } } });
    expect(fake.store.receipts.get('mine')).toMatchObject({ from: '+14165551234', merchant: 'Costco', total: 5 });
    expect(fake.store.receipts.get('mine').imagePaths).toBeUndefined();
  });

  it('import tokens: blank label gets a default, and bad ids are not-found', async () => {
    const created = await webApi.createImportToken({ ...ME, data: { label: '   ' } });
    expect(created.label).toBe('AI assistant');
    await expect(webApi.revokeImportToken({ ...ME, data: {} })).rejects.toMatchObject({ code: 'not-found' });
    await expect(webApi.revokeImportToken({ ...ME, data: { id: 'zzz' } })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('importTargetReceipts rejects a non-array payload', async () => {
    await expect(webApi.importTargetReceipts({ ...ME, data: { receipts: 'nope' } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(webApi.importTargetReceipts({ ...ME, data: {} })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('image url endpoints', () => {
  it('returns data urls for readable images and silently skips unreadable ones', async () => {
    seed('receipts', 'mine', { from: '+14165551234', imagePaths: ['ok.png', 'missing.png'] });
    files['ok.png'] = 'pngbytes';
    const { urls } = await webApi.getReceiptImageUrls({ ...ME, data: { id: 'mine' } });
    expect(urls).toEqual([`data:image/png;base64,${Buffer.from('pngbytes').toString('base64')}`]);
  });

  it('returns an empty list for a receipt with no images', async () => {
    seed('receipts', 'mine', { from: '+14165551234' });
    expect(await webApi.getReceiptImageUrls({ ...ME, data: { id: 'mine' } })).toEqual({ urls: [] });
  });

  it('failure image urls work for the owner', async () => {
    seed('processing_failures', 'f1', { from: '+14165551234', imagePaths: ['ok.png'] });
    files['ok.png'] = 'pngbytes';
    expect((await webApi.getProcessingFailureImageUrls({ ...ME, data: { id: 'f1' } })).urls).toHaveLength(1);
  });
});
