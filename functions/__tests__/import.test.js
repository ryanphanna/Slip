const { createFakeFirestore } = require('../test-helpers/fake-firestore');

jest.mock('firebase-admin', () => ({ firestore: jest.fn(), storage: jest.fn() }));
jest.mock('../lib/receipt', () => ({ parseReceiptFromBase64: jest.fn(), parseReceiptFromText: jest.fn() }));
jest.mock('../lib/gemini', () => ({ PROMPT: '', parseReceiptFromBase64: jest.fn(), parseReceiptFromText: jest.fn(), parseReceiptFromUrl: jest.fn() }));

const admin = require('firebase-admin');
const receiptLib = require('../lib/receipt');
const gemini = require('../lib/gemini');
const tokens = require('../lib/import-tokens');
const { handleMcp } = require('../lib/mcp');
const { validateImport } = require('../lib/import-schema');
const { updateReceipt, createImportToken, listImportTokens, revokeImportToken } = require('../lib/web-api');
const config = require('../lib/config');

const PHONE_A = '+14165551111';
const PHONE_B = '+14165552222';
const authFor = (uid, phone) => ({ auth: { uid, token: { phone_number: phone } } });

let fake;
beforeEach(() => {
  fake = createFakeFirestore();
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
  admin.firestore.Timestamp = fake.db.Timestamp;
  jest.clearAllMocks();
});

const valid = (over = {}) => ({
  schemaVersion: 1,
  idempotencyKey: 'key-0000001',
  merchant: 'Costco',
  total: 23.5,
  date: '2026-10-01',
  subtotal: 20.8,
  tax: 2.7,
  category: 'Grocery',
  items: [{ name: 'Milk', price: 20.8, quantity: 1 }],
  source: { client: 'claude' },
  ...over,
});

const call = (token, args) => handleMcp({
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
  body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_receipt', arguments: args } },
});
const receipts = () => [...fake.store.receipts?.entries() || []];

async function mint(phone, uid = 'u-' + phone) {
  return tokens.createToken({ from: phone, uid, label: 'test' });
}

describe('token lifecycle', () => {
  it('stores only a hash and shows the raw token once', async () => {
    const { token } = await mint(PHONE_A);
    const docs = [...fake.store.import_tokens.entries()];
    expect(docs).toHaveLength(1);
    expect(docs[0][0]).toBe(tokens.hashToken(token));
    expect(JSON.stringify(docs[0][1])).not.toContain(token);
    expect(JSON.stringify(await tokens.listTokens(PHONE_A))).not.toContain(token);
  });

  it('rejects missing, unknown and revoked tokens with 401', async () => {
    const { token, id } = await mint(PHONE_A);
    expect((await call('slip_pat_nope', valid())).status).toBe(401);
    expect((await handleMcp({ method: 'POST', headers: {}, body: {} })).status).toBe(401);
    expect((await call(token, valid())).status).toBe(200);
    await tokens.revokeToken(PHONE_A, id);
    expect((await call(token, valid({ idempotencyKey: 'key-0000002' }))).status).toBe(401);
  });

  it('cannot revoke another account\'s token', async () => {
    const { id } = await mint(PHONE_A);
    await expect(tokens.revokeToken(PHONE_B, id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('web callables require auth and are scoped to the caller', async () => {
    await expect(createImportToken({ data: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
    const created = await createImportToken({ ...authFor('ua', PHONE_A), data: { label: 'Claude' } });
    expect(created.token).toMatch(/^slip_pat_/);
    expect((await listImportTokens(authFor('ub', PHONE_B))).tokens).toHaveLength(0);
    expect((await listImportTokens(authFor('ua', PHONE_A))).tokens[0]).toMatchObject({ label: 'Claude', revoked: false });
    await revokeImportToken({ ...authFor('ua', PHONE_A), data: { id: created.id } });
    expect((await listImportTokens(authFor('ua', PHONE_A))).tokens[0].revoked).toBe(true);
  });
});

describe('MCP protocol', () => {
  it('exposes only create_receipt', async () => {
    const { token } = await mint(PHONE_A);
    const res = await handleMcp({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(res.body.result.tools.map((t) => t.name)).toEqual(['create_receipt']);
    const other = await handleMcp({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_receipts', arguments: {} } } });
    expect(other.body.error).toBeTruthy();
  });

  it('rejects non-POST and oversized bodies', async () => {
    expect((await handleMcp({ method: 'GET', headers: {}, body: {} })).status).toBe(405);
    expect((await handleMcp({ method: 'POST', headers: {}, body: {}, rawLength: 1e6 })).status).toBe(413);
  });
});

describe('validation', () => {
  it.each([
    ['bad date format', { date: '10/01/2026' }],
    ['impossible date', { date: '2026-02-31' }],
    ['future date', { date: '2099-01-01' }],
    ['string amount', { total: '23.50' }],
    ['too many decimals', { total: 1.234 }],
    ['huge amount', { total: 1e9 }],
    ['unknown category', { category: 'Crypto' }],
    ['bad item', { items: [{ name: '', price: 1 }] }],
    ['bad item category', { items: [{ name: 'x', price: 1, category: 'Nope' }] }],
    ['bad quantity', { items: [{ name: 'x', price: 1, quantity: 0 }] }],
    ['extra item field', { items: [{ name: 'x', price: 1, sku: 'a' }] }],
    ['phone smuggled in', { phone: PHONE_B }],
    ['uid smuggled in', { uid: 'other' }],
    ['from smuggled in', { from: PHONE_B }],
    ['wrong schema version', { schemaVersion: 2 }],
    ['short key', { idempotencyKey: 'abc' }],
    ['lowercase currency', { currency: 'cad' }],
    ['missing source', { source: undefined }],
  ])('rejects %s', (_n, over) => {
    expect(validateImport(valid(over)).errors.length).toBeGreaterThan(0);
  });

  it('accepts a good payload and flags inconsistencies as warnings', () => {
    expect(validateImport(valid())).toMatchObject({ errors: [], warnings: [] });
    const w = validateImport(valid({ tax: 9 })).warnings;
    expect(w).toContain('subtotal + tax does not match total');
  });

  it('returns validation failure to the assistant and writes nothing', async () => {
    const { token } = await mint(PHONE_A);
    const res = await call(token, valid({ category: 'Crypto' }));
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/category/);
    expect(receipts()).toHaveLength(0);
  });
});

describe('import', () => {
  it('saves into the token\'s account without calling Gemini and records source', async () => {
    const { token } = await mint(PHONE_A);
    const res = await call(token, valid());
    expect(res.body.result.isError).toBe(false);
    const out = res.body.result.structuredContent;
    expect(out.deduplicated).toBe(false);
    const [[id, doc]] = receipts();
    expect(out.receiptId).toBe(id);
    expect(doc).toMatchObject({ from: PHONE_A, merchant: 'Costco', total: 23.5, imagePaths: [], messageSid: null });
    expect(doc.importSource).toMatchObject({ client: 'claude', schemaVersion: 1 });
    for (const fn of [receiptLib.parseReceiptFromBase64, receiptLib.parseReceiptFromText, gemini.parseReceiptFromBase64, gemini.parseReceiptFromText, gemini.parseReceiptFromUrl]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('isolates accounts: each token writes only to its own account', async () => {
    const a = await mint(PHONE_A);
    const b = await mint(PHONE_B);
    await call(a.token, valid({ merchant: 'Costco', idempotencyKey: 'same-key-001' }));
    await call(b.token, valid({ merchant: 'IKEA', idempotencyKey: 'same-key-001' }));
    const byFrom = Object.fromEntries(receipts().map(([, d]) => [d.from, d.merchant]));
    expect(byFrom).toEqual({ [PHONE_A]: 'Costco', [PHONE_B]: 'IKEA' });
  });

  it('retrying the same idempotency key does not create another receipt', async () => {
    const { token } = await mint(PHONE_A);
    const first = (await call(token, valid())).body.result.structuredContent;
    const retry = (await call(token, valid())).body.result.structuredContent;
    expect(retry).toMatchObject({ receiptId: first.receiptId, deduplicated: true });
    expect(receipts()).toHaveLength(1);
  });

  it('rejects a reused key with different data', async () => {
    const { token } = await mint(PHONE_A);
    await call(token, valid());
    const res = await call(token, valid({ total: 99 }));
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/different receipt data/);
    expect(receipts()).toHaveLength(1);
  });

  it('keeps existing duplicate protection (same merchant, total, date)', async () => {
    const { token } = await mint(PHONE_A);
    const first = (await call(token, valid())).body.result.structuredContent;
    const second = (await call(token, valid({ idempotencyKey: 'key-0000099' }))).body.result.structuredContent;
    expect(second).toMatchObject({ duplicate: true, receiptId: first.receiptId });
    expect(receipts()).toHaveLength(1);
  });

  it('stores refunds as negative and normalizes the merchant', async () => {
    const { token } = await mint(PHONE_A);
    await call(token, valid({ merchant: 'wal-mart', type: 'refund', total: 10, subtotal: undefined, tax: undefined, items: undefined }));
    expect(receipts()[0][1]).toMatchObject({ merchant: 'Walmart', total: -10, type: 'refund' });
  });

  it('records validation warnings on the receipt', async () => {
    const { token } = await mint(PHONE_A);
    await call(token, valid({ tax: 9 }));
    expect(receipts()[0][1].importSource.warnings).toContain('subtotal + tax does not match total');
  });

  it('enforces the per-token hourly limit', async () => {
    const original = config.IMPORT_TOKEN_RATE_LIMIT_PER_HOUR;
    config.IMPORT_TOKEN_RATE_LIMIT_PER_HOUR = 3;
    const { token } = await mint(PHONE_A);
    for (let i = 0; i < 3; i++) {
      const r = await call(token, valid({ idempotencyKey: `key-${String(i).padStart(8, '0')}`, merchant: `Shop ${i}` }));
      expect(r.body.result.isError).toBe(false);
    }
    const over = await call(token, valid({ idempotencyKey: 'key-overflow', merchant: 'Shop over' }));
    expect(over.body.result.isError).toBe(true);
    expect(over.body.result.content[0].text).toMatch(/limit/i);
    expect(receipts()).toHaveLength(3);
    config.IMPORT_TOKEN_RATE_LIMIT_PER_HOUR = original;
  });

  it('enforces the shared account limit', async () => {
    const { token } = await mint(PHONE_A);
    for (let i = 0; i < config.RATE_LIMIT_PER_HOUR; i++) {
      fake.store.receipts = fake.store.receipts || new Map();
      fake.store.receipts.set(`sms-${i}`, { from: PHONE_A, createdAt: { toDate: () => new Date(), toMillis: () => Date.now() } });
    }
    const res = await call(token, valid());
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/Rate limit/);
  });

  it('imported receipts stay editable in the web app', async () => {
    const { token } = await mint(PHONE_A);
    const { receiptId } = (await call(token, valid())).body.result.structuredContent;
    const updated = await updateReceipt({ ...authFor('u', PHONE_A), data: { id: receiptId, patch: { merchant: 'Costco Wholesale' } } });
    expect(updated.merchant).toBe('Costco Wholesale');
    await expect(updateReceipt({ ...authFor('u2', PHONE_B), data: { id: receiptId, patch: { merchant: 'x' } } })).rejects.toMatchObject({ code: 'not-found' });
  });
});
