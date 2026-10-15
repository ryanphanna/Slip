const { createFakeFirestore, makeTimestamp } = require('../test-helpers/fake-firestore');

jest.mock('firebase-admin', () => ({ firestore: jest.fn(), storage: jest.fn() }));

const admin = require('firebase-admin');
const { purgeOldFailures } = require('../lib/retention');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ts = (daysAgo) => makeTimestamp(new Date(NOW - daysAgo * DAY));

let fake;
let stored;   // Set of paths that exist in storage
let deleted;  // paths deleted
beforeEach(() => {
  fake = createFakeFirestore();
  admin.firestore.mockReturnValue(fake.db);
  stored = new Set();
  deleted = [];
  admin.storage.mockReturnValue({
    bucket: () => ({
      file: (path) => ({
        delete: async () => { deleted.push(path); stored.delete(path); },
      }),
    }),
  });
});

const failure = (id, data) => {
  (fake.store.processing_failures || (fake.store.processing_failures = new Map())).set(id, { from: '+14165551234', imagePaths: [], ...data });
};
const receipt = (id, data) => {
  (fake.store.receipts || (fake.store.receipts = new Map())).set(id, { from: '+14165551234', ...data });
};
const failureIds = () => [...(fake.store.processing_failures || new Map()).keys()].sort();
const run = (opts = {}) => purgeOldFailures({ now: NOW, dryRun: false, ...opts });

describe('which rows are eligible', () => {
  it('deletes only recovered/resolved/duplicate rows older than 90 days', async () => {
    failure('rec-old', { status: 'recovered', updatedAt: ts(120), sourceText: 'secret pasted text' });
    failure('res-old', { status: 'resolved', updatedAt: ts(91) });
    failure('dup-old', { status: 'duplicate', updatedAt: ts(200) });
    failure('rec-new', { status: 'recovered', updatedAt: ts(30) });
    failure('res-new', { status: 'resolved', updatedAt: ts(89) });
    const counts = await run();
    expect(counts).toMatchObject({ eligibleRows: 3, deletedRows: 3, failedRows: 0 });
    expect(failureIds()).toEqual(['rec-new', 'res-new']);
  });

  it('never touches failed, pending, retrying or status-less rows, however old', async () => {
    for (const status of ['failed', 'pending', 'retrying', '', undefined]) {
      failure(`old-${String(status)}`, { ...(status === undefined ? {} : { status }), updatedAt: ts(1000), sourceText: 'keep me', imagePaths: ['receipts-failed/a/0.jpg'] });
    }
    stored.add('receipts-failed/a/0.jpg');
    const counts = await run();
    expect(counts.eligibleRows).toBe(0);
    expect(failureIds()).toHaveLength(5);
    expect(deleted).toEqual([]);
  });

  it('skips old finished rows that have no updatedAt (age unknown)', async () => {
    failure('no-date', { status: 'recovered' });
    const counts = await run();
    expect(counts.eligibleRows).toBe(0);
    expect(failureIds()).toEqual(['no-date']);
  });

  it('the cutoff is configurable and exact to the day', async () => {
    failure('a', { status: 'recovered', updatedAt: ts(10) });
    expect((await run({ retentionDays: 30 })).eligibleRows).toBe(0);
    expect((await run({ retentionDays: 9 })).deletedRows).toBe(1);
  });
});

describe('stored images', () => {
  it('deletes an image that no receipt or other failure references', async () => {
    stored.add('receipts-failed/SM1/0.jpg');
    failure('f1', { status: 'resolved', updatedAt: ts(100), imagePaths: ['receipts-failed/SM1/0.jpg'] });
    const counts = await run();
    expect(deleted).toEqual(['receipts-failed/SM1/0.jpg']);
    expect(counts).toMatchObject({ deletedImages: 1, sharedImages: 0, deletedRows: 1 });
  });

  it('NEVER deletes an image a saved receipt references (recovered failures share it), but still deletes the failure row', async () => {
    stored.add('receipts-failed/SM2/0.jpg');
    failure('f2', { status: 'recovered', updatedAt: ts(100), imagePaths: ['receipts-failed/SM2/0.jpg'], recoveredReceiptId: 'r2' });
    receipt('r2', { imagePaths: ['receipts-failed/SM2/0.jpg'], recoveredFromFailure: 'f2' });
    const counts = await run();
    expect(deleted).toEqual([]);
    expect(stored.has('receipts-failed/SM2/0.jpg')).toBe(true);
    expect(counts).toMatchObject({ sharedImages: 1, deletedImages: 0, deletedRows: 1 });
    expect(failureIds()).toEqual([]);
  });

  it('protects only the shared path when a failure has several images', async () => {
    failure('f3', { status: 'recovered', updatedAt: ts(100), imagePaths: ['receipts-failed/SM3/0.jpg', 'receipts-failed/SM3/1.jpg'] });
    receipt('r3', { imagePaths: ['receipts-failed/SM3/0.jpg'] });
    stored.add('receipts-failed/SM3/0.jpg'); stored.add('receipts-failed/SM3/1.jpg');
    await run();
    expect(deleted).toEqual(['receipts-failed/SM3/1.jpg']);
  });

  it('keeps an image still referenced by another failure row (e.g. a failed one)', async () => {
    failure('old', { status: 'resolved', updatedAt: ts(100), imagePaths: ['receipts-failed/SM4/0.jpg'] });
    failure('live', { status: 'failed', updatedAt: ts(1), imagePaths: ['receipts-failed/SM4/0.jpg'] });
    const counts = await run();
    expect(deleted).toEqual([]);
    expect(counts.sharedImages).toBe(1);
    expect(failureIds()).toEqual(['live']);
  });

  it('skips images outside the failed-image prefix or with odd paths', async () => {
    failure('f5', { status: 'resolved', updatedAt: ts(100), imagePaths: ['receipts-permanent/SM5/0.jpg', 'receipts-failed/../x.jpg', 42, ''] });
    const counts = await run();
    expect(deleted).toEqual([]);
    expect(counts.skippedImages).toBe(4);
    expect(counts.deletedRows).toBe(1);
  });

  it('skips the image (but removes the row) when the reference check itself fails', async () => {
    failure('f6', { status: 'resolved', updatedAt: ts(100), imagePaths: ['receipts-failed/SM6/0.jpg'] });
    const real = fake.db.collection;
    fake.db.collection = (name) => {
      const col = real(name);
      if (name !== 'receipts') return col;
      return Object.assign(Object.create(col), { where: () => ({ limit: () => ({ get: async () => { throw new Error('unavailable'); } }) }) });
    };
    const counts = await run();
    expect(deleted).toEqual([]);
    expect(counts).toMatchObject({ skippedImages: 1, deletedRows: 1 });
  });
});

describe('cap and dry-run', () => {
  it('handles at most maxRows per run, oldest first, across statuses', async () => {
    for (let i = 0; i < 5; i++) failure(`rec${i}`, { status: 'recovered', updatedAt: ts(100 + i) });
    for (let i = 0; i < 5; i++) failure(`res${i}`, { status: 'resolved', updatedAt: ts(300 + i) });
    const counts = await run({ maxRows: 7 });
    expect(counts).toMatchObject({ eligibleRows: 7, deletedRows: 7 });
    expect(failureIds()).toHaveLength(3);
    const second = await run({ maxRows: 7 });
    expect(second.deletedRows).toBe(3);
    expect(failureIds()).toEqual([]);
  });

  it('dry-run reports what would happen and changes nothing', async () => {
    stored.add('receipts-failed/SM7/0.jpg');
    failure('f7', { status: 'resolved', updatedAt: ts(100), imagePaths: ['receipts-failed/SM7/0.jpg'], sourceText: 'text' });
    failure('f8', { status: 'recovered', updatedAt: ts(100), imagePaths: ['receipts-failed/SM8/0.jpg'] });
    receipt('r8', { imagePaths: ['receipts-failed/SM8/0.jpg'] });
    const counts = await run({ dryRun: true });
    expect(counts).toMatchObject({ dryRun: true, eligibleRows: 2, deletedRows: 2, deletedImages: 1, sharedImages: 1 });
    expect(failureIds()).toEqual(['f7', 'f8']);
    expect(deleted).toEqual([]);
    expect(stored.has('receipts-failed/SM7/0.jpg')).toBe(true);
  });

  it('defaults to dry-run when no flag is given', async () => {
    failure('f9', { status: 'resolved', updatedAt: ts(100) });
    const counts = await purgeOldFailures({ now: NOW });
    expect(counts.dryRun).toBe(true);
    expect(failureIds()).toEqual(['f9']);
  });

  it('returns counts only (no document content)', async () => {
    failure('f10', { status: 'resolved', updatedAt: ts(100), sourceText: 'my secret receipt text', from: '+14165559999' });
    const counts = await run();
    expect(JSON.stringify(counts)).not.toMatch(/secret|\+1416|f10/);
    expect(Object.values(counts).every((v) => typeof v === 'number' || typeof v === 'boolean')).toBe(true);
  });

  it('keeps going when one row cannot be deleted and counts it', async () => {
    failure('ok', { status: 'resolved', updatedAt: ts(100) });
    failure('bad', { status: 'resolved', updatedAt: ts(101) });
    const real = fake.db.collection;
    fake.db.collection = (name) => {
      const col = real(name);
      if (name !== 'processing_failures') return col;
      return Object.assign(Object.create(col), {
        where: (...a) => {
          const q = col.where(...a);
          return wrap(q);
        },
      });
    };
    function wrap(q) {
      return Object.assign(Object.create(q), {
        where: (...a) => wrap(q.where(...a)),
        orderBy: (...a) => wrap(q.orderBy(...a)),
        limit: (...a) => wrap(q.limit(...a)),
        get: async () => {
          const snap = await q.get();
          snap.docs.forEach((d) => { if (d.id === 'bad') d.ref = { delete: async () => { throw new Error('nope'); } }; });
          return snap;
        },
      });
    }
    const counts = await run();
    expect(counts).toMatchObject({ eligibleRows: 2, deletedRows: 1, failedRows: 1 });
    expect(failureIds()).toEqual(['bad']);
  });
});
