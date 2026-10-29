const { createFakeFirestore } = require('../test-helpers/fake-firestore');

let fake;
let storageFiles;

jest.mock('firebase-admin', () => ({ firestore: jest.fn(), storage: jest.fn() }));
jest.mock('../lib/receipt', () => ({ parseReceiptFromBase64: jest.fn(), parseReceiptFromText: jest.fn(), photoReadNothing: (raw) => !raw || (raw.merchant == null && raw.total == null && (!Array.isArray(raw.items) || raw.items.length === 0)), groupReceiptPhotos: jest.fn(async (images) => [images.map((_, i) => i)]) }));

const admin = require('firebase-admin');
const { parseReceiptFromBase64, parseReceiptFromText } = require('../lib/receipt');
const {
  cleanPatch, requireAuth, EDITABLE_FIELDS, VISIBLE_FAILURE_STATUSES,
  listReceipts, getReceipt, updateReceipt, listProcessingFailures, listNotifications,
  retryProcessing, importTargetReceipts, listItems, updateItem,
  getUserSettings, updateUserSettings,
} = require('../lib/web-api');

process.env.ALLOWED_PHONES = '+14165551234,+14165559999';

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
  parseReceiptFromText.mockReset();
});

function seed(collection, id, data) {
  const map = fake.store[collection] || (fake.store[collection] = new Map());
  map.set(id, data);
}

describe('allowlist enforcement', () => {
  const webApi = require('../lib/web-api');
  const handlers = Object.entries(webApi).filter(([name, fn]) => typeof fn === 'function' && !['requireAuth', 'cleanPatch'].includes(name));
  const STRANGER = { auth: { uid: 'stranger', token: { phone_number: '+14165550000' } } };
  const originalAllowed = process.env.ALLOWED_PHONES;
  afterEach(() => { process.env.ALLOWED_PHONES = originalAllowed; });

  it('covers every exported callable handler', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(16);
  });

  it.each(handlers.map(([name]) => [name]))('%s rejects a signed-in phone that is not allowlisted', async (name) => {
    await expect(webApi[name]({ ...STRANGER, data: { id: 'x', receipts: [{}], patch: {} } }))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(Object.values(fake.store).filter((m) => m instanceof Map).every((m) => m.size === 0)).toBe(true);
  });

  it.each(handlers.map(([name]) => [name]))('%s fails closed when ALLOWED_PHONES is unset', async (name) => {
    delete process.env.ALLOWED_PHONES;
    await expect(webApi[name]({ ...AUTH, data: {} })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('lets an allowlisted phone through', () => {
    expect(requireAuth(AUTH)).toEqual({ uid: 'user-1', phone: '+14165551234' });
    expect(requireAuth({ auth: { uid: 'u2', token: { phone_number: '+14165559999' } } }).phone).toBe('+14165559999');
  });

  it('still reports unauthenticated before checking the allowlist', () => {
    expect(() => requireAuth({ auth: null })).toThrow('Authentication required');
  });
});

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

describe('updateReceipt validation and merchantKey', () => {
  const PHONE = '+14165551234';
  const base = { from: PHONE, merchant: 'Costco', merchantKey: 'costco', total: 50, subtotal: 45, tax: 5, date: '2026-03-14', currency: 'CAD', category: 'Grocery', items: [] };
  const run = (patch, id = 'r1') => updateReceipt({ ...AUTH, data: { id, patch } });

  it('recomputes merchantKey when the merchant changes (and fills a missing one)', async () => {
    seed('receipts', 'r1', base);
    await run({ merchant: 'IKEA' });
    expect(fake.store.receipts.get('r1')).toMatchObject({ merchant: 'IKEA', merchantKey: 'ikea' });
    seed('receipts', 'r2', { ...base, merchantKey: undefined });
    await run({ category: 'Home' }, 'r2');
    expect(fake.store.receipts.get('r2').merchantKey).toBe('costco');
  });

  it.each([
    [{ date: '2026-13-45' }],
    [{ currency: 'cad' }],
    [{ total: '1,234.50' }],
  ])('rejects %j and leaves the stored receipt untouched', async (patch) => {
    seed('receipts', 'r1', base);
    await expect(run(patch)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(fake.store.receipts.get('r1')).toMatchObject({ date: '2026-03-14', currency: 'CAD', total: 50 });
  });

  it('empty subtotal/tax clear to null rather than 0', async () => {
    seed('receipts', 'r1', base);
    await run({ subtotal: null, tax: '' });
    expect(fake.store.receipts.get('r1')).toMatchObject({ subtotal: null, tax: null });
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
    expect(receipt.data().merchantKey).toBe('costco');
  });

  it('flags a re-read photo that came back with no items or no date', async () => {
    storageFiles['path/a.jpg'] = { content: 'img', contentType: 'image/jpeg' };
    seed('processing_failures', 'f1', { from: '+14165551234', imagePaths: ['path/a.jpg'] });
    parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 12.5, date: null, items: [] });

    const result = await retryProcessing({ ...AUTH, data: { id: 'f1' } });
    expect(fake.store.receipts.get(result.id)).toMatchObject({ itemsNeedCheck: true, dateNeedsCheck: true });
  });

  it('keeps the failure open instead of saving a blank receipt when the photos still read as nothing', async () => {
    storageFiles['path/a.jpg'] = { content: 'img', contentType: 'image/jpeg' };
    seed('processing_failures', 'f1', { from: '+14165551234', imagePaths: ['path/a.jpg'], status: 'failed' });
    parseReceiptFromBase64.mockResolvedValue({ merchant: null, total: null, items: [] });

    await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(fake.store.receipts ? fake.store.receipts.size : 0).toBe(0);
    expect(fake.store.processing_failures.get('f1')).toMatchObject({ status: 'failed', retryToken: null });
  });

  it('a recovered receipt keeps its place in a multi-receipt text', async () => {
    storageFiles['path/a.jpg'] = { content: 'img', contentType: 'image/jpeg' };
    seed('processing_failures', 'SM1-1', { from: '+14165551234', messageSid: 'SM1', messagePart: 1, imagePaths: ['path/a.jpg'] });
    parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 12.5, date: '2026-10-01', items: [{ name: 'Milk', price: 12.5 }] });

    const result = await retryProcessing({ ...AUTH, data: { id: 'SM1-1' } });
    expect(fake.store.receipts.get(result.id)).toMatchObject({ messageSid: 'SM1', messagePart: 1 });
  });

  describe('repeat and concurrent retries', () => {
    const PHONE = '+14165551234';
    const seedFailure = (id = 'f1', extra = {}) => {
      storageFiles['path/a.jpg'] = { content: 'img', contentType: 'image/jpeg' };
      seed('processing_failures', id, { from: PHONE, imagePaths: ['path/a.jpg'], ...extra });
    };
    const receiptCount = () => (fake.store.receipts ? fake.store.receipts.size : 0);

    it('rejects an already-recovered failure without calling Gemini or adding a receipt', async () => {
      seedFailure('f1', { status: 'recovered', recoveredReceiptId: 'r1' });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(parseReceiptFromBase64).not.toHaveBeenCalled();
      expect(receiptCount()).toBe(0);
    });

    it('a second sequential retry after success is rejected and adds nothing', async () => {
      seedFailure();
      parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 12.5, items: [] });
      await retryProcessing({ ...AUTH, data: { id: 'f1' } });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(parseReceiptFromBase64).toHaveBeenCalledTimes(1);
      expect(receiptCount()).toBe(1);
    });

    it('simultaneous retries make one Gemini call and one receipt', async () => {
      seedFailure();
      parseReceiptFromBase64.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { merchant: 'Costco', total: 12.5, items: [] };
      });
      const results = await Promise.allSettled([
        retryProcessing({ ...AUTH, data: { id: 'f1' } }),
        retryProcessing({ ...AUTH, data: { id: 'f1' } }),
        retryProcessing({ ...AUTH, data: { id: 'f1' } }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'failed-precondition')).toBe(true);
      expect(parseReceiptFromBase64).toHaveBeenCalledTimes(1);
      expect(receiptCount()).toBe(1);
    });

    it('a failed parse releases the claim so the user can retry again', async () => {
      seedFailure('f1', { status: 'failed' });
      parseReceiptFromBase64.mockRejectedValueOnce(new Error('gemini down'));
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toThrow('gemini down');
      expect(fake.store.processing_failures.get('f1').status).toBe('failed');
      expect(receiptCount()).toBe(0);
      parseReceiptFromBase64.mockResolvedValueOnce({ merchant: 'Costco', total: 5, items: [] });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).resolves.toMatchObject({ merchant: 'Costco' });
    });

    it('rejects a fresh in-progress claim but takes over a stale one', async () => {
      const stamp = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
      seedFailure('f1', { status: 'retrying', retryToken: 'other', retryStartedAt: stamp(Date.now()) });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition' });
      fake.store.processing_failures.get('f1').retryStartedAt = stamp(Date.now() - 10 * 60 * 1000);
      parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 5, items: [] });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).resolves.toMatchObject({ merchant: 'Costco' });
    });

    it('rate-limits retries per account and keeps accounts separate', async () => {
      const config = require('../lib/config');
      parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 5, items: [] });
      for (let i = 0; i < config.RETRY_RATE_LIMIT_PER_HOUR; i++) {
        seedFailure(`f${i}`);
        await retryProcessing({ ...AUTH, data: { id: `f${i}` } });
      }
      seedFailure('over');
      await expect(retryProcessing({ ...AUTH, data: { id: 'over' } })).rejects.toMatchObject({ code: 'resource-exhausted' });
      expect(parseReceiptFromBase64).toHaveBeenCalledTimes(config.RETRY_RATE_LIMIT_PER_HOUR);

      const OTHER = { auth: { uid: 'user-2', token: { phone_number: '+14165559999' } } };
      seed('processing_failures', 'other-1', { from: '+14165559999', imagePaths: ['path/a.jpg'] });
      await expect(retryProcessing({ ...OTHER, data: { id: 'other-1' } })).resolves.toMatchObject({ merchant: 'Costco' });
    });

    it('retrying failures stay visible in the failures list', async () => {
      expect(VISIBLE_FAILURE_STATUSES.has('retrying')).toBe(true);
      seed('processing_failures', 'f1', { from: PHONE, status: 'retrying', imagePaths: ['p'], createdAt: { toMillis: () => 1 } });
      const { failures } = await listProcessingFailures(AUTH);
      expect(failures.map((f) => f.id)).toEqual(['f1']);
    });

    it('a stale takeover remembers the original status, not "retrying"', async () => {
      const stamp = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
      seedFailure('f1', { status: 'retrying', previousStatus: 'pending', retryToken: 'dead', retryStartedAt: stamp(Date.now() - 10 * 60 * 1000) });
      parseReceiptFromBase64.mockRejectedValueOnce(new Error('gemini down'));
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toThrow('gemini down');
      expect(fake.store.processing_failures.get('f1').status).toBe('pending');

      // Claim without a stored previousStatus falls back to 'failed'.
      seedFailure('f2', { status: 'retrying', retryToken: 'dead', retryStartedAt: stamp(Date.now() - 10 * 60 * 1000) });
      parseReceiptFromBase64.mockRejectedValueOnce(new Error('gemini down'));
      await expect(retryProcessing({ ...AUTH, data: { id: 'f2' } })).rejects.toThrow('gemini down');
      expect(fake.store.processing_failures.get('f2').status).toBe('failed');
    });

    it('a superseded retry cannot overwrite the newer claim or finished state when it fails', async () => {
      seedFailure('f1', { status: 'failed' });
      let release;
      parseReceiptFromBase64.mockImplementationOnce(() => new Promise((_, reject) => { release = () => reject(new Error('late failure')); }));
      const first = retryProcessing({ ...AUTH, data: { id: 'f1' } });
      await new Promise((r) => setTimeout(r, 5));
      // Another retry took over (token changed) and recovered the receipt.
      fake.store.processing_failures.set('f1', { ...fake.store.processing_failures.get('f1'), status: 'recovered', retryToken: null, recoveredReceiptId: 'rX' });
      release();
      await expect(first).rejects.toThrow('late failure');
      expect(fake.store.processing_failures.get('f1')).toMatchObject({ status: 'recovered', recoveredReceiptId: 'rX' });
    });

    it('also does not release when the final write fails after another token took the claim', async () => {
      seedFailure('f1', { status: 'failed' });
      parseReceiptFromBase64.mockImplementationOnce(async () => {
        fake.store.processing_failures.set('f1', { ...fake.store.processing_failures.get('f1'), status: 'retrying', retryToken: 'someone-else' });
        return { merchant: 'Costco', total: 5, items: [] };
      });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(fake.store.processing_failures.get('f1')).toMatchObject({ status: 'retrying', retryToken: 'someone-else' });
      expect(receiptCount()).toBe(0);
    });

    it('refunds the rate-limit slot when the retry fails before parsing succeeds', async () => {
      const config = require('../lib/config');
      for (let i = 0; i < config.RETRY_RATE_LIMIT_PER_HOUR * 2; i++) {
        seedFailure('f1', { status: 'failed' });
        parseReceiptFromBase64.mockRejectedValueOnce(new Error('gemini down'));
        await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toThrow('gemini down');
      }
      expect(fake.store.retry_limits.get('14165551234').count).toBe(0);
      parseReceiptFromBase64.mockResolvedValueOnce({ merchant: 'Costco', total: 5, items: [] });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).resolves.toMatchObject({ merchant: 'Costco' });
      expect(fake.store.retry_limits.get('14165551234').count).toBe(1);
    });

    it('keeps the slot used when parsing succeeded but the final write failed', async () => {
      seedFailure('f1', { status: 'failed' });
      parseReceiptFromBase64.mockImplementationOnce(async () => {
        fake.store.processing_failures.get('f1').retryToken = 'other';
        return { merchant: 'Costco', total: 5, items: [] };
      });
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toBeTruthy();
      expect(fake.store.retry_limits.get('14165551234').count).toBe(1);
    });

    describe('text-only failures', () => {
      const seedTextFailure = (id = 'f1', extra = {}) => seed('processing_failures', id, { from: PHONE, imagePaths: [], numMedia: 0, status: 'failed', sourceText: 'Costco milk 20.80 total 23.50', ...extra });

      it('re-parses the stored text (no image needed) and recovers the receipt', async () => {
        seedTextFailure('f1', { messageSid: 'SM9' });
        parseReceiptFromText.mockResolvedValue({ merchant: 'Costco', total: 23.5, category: 'Grocery', items: [{ name: 'Milk', price: 20.8 }], confidence: 0.9 });
        const result = await retryProcessing({ ...AUTH, data: { id: 'f1' } });
        expect(parseReceiptFromText).toHaveBeenCalledWith('Costco milk 20.80 total 23.50', true); // account has no receipts yet -> first-receipt Pro flag
        expect(parseReceiptFromBase64).not.toHaveBeenCalled();
        expect(result.merchant).toBe('Costco');
        expect(fake.store.receipts.get(result.id)).toMatchObject({ from: PHONE, merchant: 'Costco', merchantKey: 'costco', imagePaths: [], messageSid: 'SM9', recoveredFromFailure: 'f1' });
        expect(fake.store.processing_failures.get('f1')).toMatchObject({ status: 'recovered', recoveredReceiptId: result.id });
      });

      it('does not flag a pasted text with no items, which is normal', async () => {
        seedTextFailure('f1');
        parseReceiptFromText.mockResolvedValue({ merchant: 'Costco', total: 23.5, date: '2026-10-01', items: [] });
        const result = await retryProcessing({ ...AUTH, data: { id: 'f1' } });
        expect(fake.store.receipts.get(result.id).itemsNeedCheck).toBeUndefined();
      });

      it('a second retry of the same text failure is rejected (no duplicate, no second Gemini call)', async () => {
        seedTextFailure();
        parseReceiptFromText.mockResolvedValue({ merchant: 'Costco', total: 23.5, items: [] });
        await retryProcessing({ ...AUTH, data: { id: 'f1' } });
        await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition' });
        expect(parseReceiptFromText).toHaveBeenCalledTimes(1);
        expect(receiptCount()).toBe(1);
      });

      it('a parse failure releases the claim and refunds the slot, leaving the text intact', async () => {
        seedTextFailure();
        parseReceiptFromText.mockRejectedValueOnce(new Error('gemini down'));
        await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toThrow('gemini down');
        expect(fake.store.processing_failures.get('f1')).toMatchObject({ status: 'failed', sourceText: 'Costco milk 20.80 total 23.50' });
        expect(fake.store.retry_limits.get('14165551234').count).toBe(0);
      });

      it('text that is not a receipt is closed as resolved, never saved, and not retryable again', async () => {
        seedTextFailure();
        parseReceiptFromText.mockResolvedValue({ merchant: null, total: null, items: [] });
        await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition', message: "That text didn't look like a receipt" });
        expect(receiptCount()).toBe(0);
        expect(fake.store.processing_failures.get('f1')).toMatchObject({ status: 'resolved', resolution: 'not-a-receipt', retryToken: null });
        // A second click does not call Gemini again.
        await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition' });
        expect(parseReceiptFromText).toHaveBeenCalledTimes(1);
        // The Gemini call was made, so the hourly slot stays used.
        expect(fake.store.retry_limits.get('14165551234').count).toBe(1);
      });

      it('passes the first-receipt flag only when the account has no receipts', async () => {
        parseReceiptFromText.mockResolvedValue({ merchant: 'Costco', total: 5, items: [] });
        seedTextFailure('f1');
        await retryProcessing({ ...AUTH, data: { id: 'f1' } });
        expect(parseReceiptFromText).toHaveBeenLastCalledWith('Costco milk 20.80 total 23.50', true);
        seedTextFailure('f2');
        await retryProcessing({ ...AUTH, data: { id: 'f2' } }); // f1's recovered receipt now exists
        expect(parseReceiptFromText).toHaveBeenLastCalledWith('Costco milk 20.80 total 23.50', false);
      });

      it('image retries use the same first-receipt flag', async () => {
        seedFailure('f1');
        parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 5, items: [] });
        await retryProcessing({ ...AUTH, data: { id: 'f1' } });
        expect(parseReceiptFromBase64.mock.calls[0][2]).toBe(true);
      });

      it('an already resolved failure cannot be retried', async () => {
        seedTextFailure('f1', { status: 'resolved' });
        await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toMatchObject({ code: 'failed-precondition', message: 'This item was already resolved' });
        expect(parseReceiptFromText).not.toHaveBeenCalled();
        expect(receiptCount()).toBe(0);
      });

      it('a failure with neither images nor text still cannot be retried', async () => {
        seed('processing_failures', 'f1', { from: PHONE, imagePaths: [], sourceText: '   ' });
        await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).rejects.toThrow('no stored image or text');
        expect(parseReceiptFromText).not.toHaveBeenCalled();
      });

      it('image failures still use the image path even if text is present', async () => {
        seedFailure('f1', { sourceText: 'ignored' });
        parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 5, items: [] });
        await retryProcessing({ ...AUTH, data: { id: 'f1' } });
        expect(parseReceiptFromBase64).toHaveBeenCalledTimes(1);
        expect(parseReceiptFromText).not.toHaveBeenCalled();
      });

      it('is listed as retryable without leaking the pasted text', async () => {
        seedTextFailure('t1', { createdAt: { toMillis: () => 2 } });
        seed('processing_failures', 'empty', { from: PHONE, imagePaths: [], status: 'failed', createdAt: { toMillis: () => 3 } });
        const { failures } = await listProcessingFailures(AUTH);
        expect(failures.map((f) => f.id)).toEqual(['t1']);
        expect(failures[0].hasSourceText).toBe(true);
        expect(failures[0].sourceText).toBeUndefined();
      });
    });

    it('resets the rate-limit window after an hour', async () => {
      const config = require('../lib/config');
      parseReceiptFromBase64.mockResolvedValue({ merchant: 'Costco', total: 5, items: [] });
      seed('retry_limits', '14165551234', { from: PHONE, windowStart: Date.now() - config.RETRY_RATE_LIMIT_WINDOW_MS - 1000, count: 999 });
      seedFailure();
      await expect(retryProcessing({ ...AUTH, data: { id: 'f1' } })).resolves.toMatchObject({ merchant: 'Costco' });
    });
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

  it('stores the receipt currency on each catalog item', async () => {
    await importTargetReceipts({ ...AUTH, data: { receipts: [{ ...validRecord, currency: 'USD' }] } });
    const items = [...fake.store.items.values()];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'Widget', currency: 'USD', merchantKey: 'target' });
    const { items: listed } = await listItems({ ...AUTH, data: {} });
    expect(listed[0].currency).toBe('USD');
  });

  it('flags a record saved without a currency, but not one that has it', async () => {
    const { imported } = await importTargetReceipts({ ...AUTH, data: { receipts: [validRecord, { ...validRecord, sourceOrderId: 'ord-2', date: '2026-01-02', currency: 'USD' }] } });
    const [missing, given] = await Promise.all(imported.map(({ id }) => fake.db.collection('receipts').doc(id).get()));
    expect(missing.data()).toMatchObject({ currency: 'CAD', currencyNeedsCheck: true });
    expect(given.data().currency).toBe('USD');
    expect(given.data().currencyNeedsCheck).toBeUndefined();
  });

  it('clears the currency flag when the record is re-imported with a currency', async () => {
    const { imported } = await importTargetReceipts({ ...AUTH, data: { receipts: [validRecord] } });
    await importTargetReceipts({ ...AUTH, data: { receipts: [{ ...validRecord, currency: 'USD' }] } });
    const receipt = (await fake.db.collection('receipts').doc(imported[0].id).get()).data();
    expect(receipt.currency).toBe('USD');
    expect(receipt.currencyNeedsCheck).toBeUndefined();
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

describe('updateItem validation', () => {
  const PHONE = '+14165551234';
  const run = (patch) => updateItem({ ...AUTH, data: { id: 'a', patch } });
  beforeEach(() => seed('items', 'a', { from: PHONE, name: 'Milk', category: 'Grocery', verified: false, publicName: 'Milk' }));

  it.each([
    ['verified as a string', { verified: 'yes' }],
    ['verified as a number', { verified: 1 }],
    ['category not in the allowed list', { category: 'Crypto' }],
    ['category as a number', { category: 5 }],
    ['name as a number', { name: 5 }],
    ['name that is only spaces', { name: '   ' }],
    ['name that is too long', { name: 'x'.repeat(201) }],
    ['publicName as an object', { publicName: { a: 1 } }],
    ['itemNumber as a number', { itemNumber: 12345 }],
    ['upc too long', { upc: '1'.repeat(33) }],
    ['productUrl that is not http(s)', { productUrl: 'javascript:alert(1)' }],
    ['productUrl too long', { productUrl: 'https://x.test/' + 'a'.repeat(500) }],
    ['patch as an array', ['verified']],
    ['patch as a string', 'verified'],
  ])('rejects %s and stores nothing', async (_n, patch) => {
    await expect(run(patch)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(fake.store.items.get('a')).toEqual({ from: PHONE, name: 'Milk', category: 'Grocery', verified: false, publicName: 'Milk' });
  });

  it('accepts valid values and normalizes them', async () => {
    const result = await run({
      verified: true, category: 'Home', name: '  Lamp ', publicName: 'Floor lamp', itemNumber: ' 123.456.78 ',
      upc: '0123', dpci: '1-2-3', productUrl: ' https://example.test/lamp ',
    });
    expect(result).toMatchObject({ verified: true, category: 'Home', name: 'Lamp', itemNumber: '123.456.78', productUrl: 'https://example.test/lamp' });
    expect(fake.store.items.get('a')).toMatchObject({ verified: true, category: 'Home', name: 'Lamp' });
  });

  it('allows clearing optional text fields with an empty string', async () => {
    await run({ publicName: '', productUrl: '' });
    expect(fake.store.items.get('a')).toMatchObject({ publicName: '', productUrl: '' });
  });

  it('still drops unknown and protected fields without error', async () => {
    await run({ verified: true, from: '+19999999999', price: 'free', id: 'zzz' });
    expect(fake.store.items.get('a')).toMatchObject({ from: PHONE, verified: true });
    expect(fake.store.items.get('a').price).toBeUndefined();
  });

  it('an empty or missing patch only touches updatedAt', async () => {
    await expect(run({})).resolves.toMatchObject({ name: 'Milk' });
    await expect(updateItem({ ...AUTH, data: { id: 'a' } })).resolves.toMatchObject({ name: 'Milk' });
  });

  it('reports another account\'s item as not-found before validating the patch', async () => {
    seed('items', 'theirs', { from: '+19999999999', name: 'x' });
    await expect(updateItem({ ...AUTH, data: { id: 'theirs', patch: { verified: 'bad' } } })).rejects.toMatchObject({ code: 'not-found' });
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
