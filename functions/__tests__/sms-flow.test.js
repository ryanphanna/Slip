// End-to-end tests of the sms handler against the in-memory fake Firestore.
// Only the outside world is mocked (Twilio, Gemini, image storage).
const { createFakeFirestore, makeTimestamp } = require('../test-helpers/fake-firestore');

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((_o, handler) => handler),
  onCall: jest.fn((...args) => args[args.length - 1]),
  HttpsError: class HttpsError extends Error {},
}));
jest.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: jest.fn((_o, h) => h) }));
jest.mock('firebase-functions/params', () => ({ defineSecret: jest.fn(() => ({ value: () => '' })) }));
jest.mock('firebase-functions/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('firebase-admin', () => ({ initializeApp: jest.fn(), firestore: jest.fn(), storage: jest.fn(), auth: jest.fn() }));
jest.mock('../lib/twilio', () => ({
  validateTwilioSignature: jest.fn(),
  sendSms: jest.fn(),
  fetchMedia: jest.fn(),
}));
jest.mock('../lib/receipt', () => ({ parseReceiptFromBase64: jest.fn(), parseReceiptFromText: jest.fn() }));
jest.mock('../lib/image-store', () => ({ saveImages: jest.fn(), saveFailedImages: jest.fn() }));

const FROM = '+14165551234';
process.env.ALLOWED_PHONES = FROM;

const admin = require('firebase-admin');
const { validateTwilioSignature, sendSms, fetchMedia } = require('../lib/twilio');
const { parseReceiptFromBase64, parseReceiptFromText } = require('../lib/receipt');
const { saveImages, saveFailedImages } = require('../lib/image-store');
const config = require('../lib/config');
const { sms } = require('../index');

let fake;
beforeEach(() => {
  fake = createFakeFirestore();
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
  admin.firestore.Timestamp = fake.db.Timestamp;
  jest.clearAllMocks();
  validateTwilioSignature.mockReturnValue(true);
  sendSms.mockResolvedValue();
  saveImages.mockResolvedValue([]);
  saveFailedImages.mockResolvedValue(['receipts-failed/SM1/0.jpg']);
});

const GOOD = {
  merchant: 'Costco', date: '2026-10-01', total: 23.5, subtotal: 20.8, tax: 2.7, category: 'Grocery',
  items: [{ name: 'Milk', price: 20.8, quantity: 1 }], currency: 'CAD', type: 'purchase', confidence: 0.95,
};

const receipts = () => [...(fake.store.receipts || new Map()).entries()];
const failures = () => [...(fake.store.processing_failures || new Map()).entries()];
const seed = (collection, id, data) => {
  (fake.store[collection] || (fake.store[collection] = new Map())).set(id, data);
};

function makeRes() {
  return { status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
}
function makeReq(body = {}, overrides = {}) {
  return { method: 'POST', headers: {}, body: { From: FROM, MessageSid: 'SM1', NumMedia: '0', Body: '', ...body }, ...overrides };
}
// The handler acks Twilio first and keeps working in the background, so wait for the work to land.
async function waitFor(check, label = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const lastSms = () => sendSms.mock.calls.at(-1)?.[1];
const imageResponse = (bytes = 'img') => ({
  headers: { get: (h) => (h === 'content-length' ? String(bytes.length) : null) },
  arrayBuffer: async () => Buffer.from(bytes),
});

describe('request validation', () => {
  it('rejects non-POST with 405', async () => {
    const res = makeRes();
    await sms(makeReq({}, { method: 'GET' }), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it.each([
    ['missing body', { body: undefined }],
  ])('rejects %s with 400', async (_n, over) => {
    const res = makeRes();
    await sms({ method: 'POST', headers: {}, ...over }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a missing From and a bad NumMedia with 400', async () => {
    let res = makeRes();
    await sms(makeReq({ From: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    res = makeRes();
    await sms(makeReq({ NumMedia: '-3' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a bad Twilio signature with 403 and does nothing', async () => {
    validateTwilioSignature.mockReturnValue(false);
    const res = makeRes();
    await sms(makeReq({ Body: 'hello receipt' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(sendSms).not.toHaveBeenCalled();
    expect(parseReceiptFromText).not.toHaveBeenCalled();
  });

  it('silently acks an unlisted sender: no reply, no parsing, no data', async () => {
    const res = makeRes();
    await sms(makeReq({ From: '+14165550000', Body: 'Costco 23.50' }), res);
    expect(res.send).toHaveBeenCalledWith('<Response/>');
    expect(sendSms).not.toHaveBeenCalled();
    expect(parseReceiptFromText).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(0);
  });

  it('acks a repeated MessageSid without reprocessing (idempotency)', async () => {
    seed('receipts', 'old', { from: FROM, messageSid: 'SM1', createdAt: makeTimestamp(new Date()) });
    const res = makeRes();
    await sms(makeReq({ Body: 'Costco 23.50' }), res);
    expect(res.send).toHaveBeenCalledWith('<Response/>');
    expect(parseReceiptFromText).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(1);
  });

  it('enforces the hourly rate limit with a message and no parsing', async () => {
    for (let i = 0; i < config.RATE_LIMIT_PER_HOUR; i++) {
      seed('receipts', `r${i}`, { from: FROM, createdAt: makeTimestamp(new Date()), merchant: `m${i}` });
    }
    const res = makeRes();
    await sms(makeReq({ MessageSid: 'SMnew', Body: 'Costco 23.50' }), res);
    expect(lastSms()).toMatch(/hourly limit/);
    expect(parseReceiptFromText).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(config.RATE_LIMIT_PER_HOUR);
  });

  it('refuses too many attachments', async () => {
    const res = makeRes();
    await sms(makeReq({ NumMedia: String(config.MAX_MEDIA_ATTACHMENTS + 1) }), res);
    expect(lastSms()).toMatch(/photos at a time/);
    expect(fetchMedia).not.toHaveBeenCalled();
  });
});

describe('happy path: pasted text', () => {
  it('acks Twilio before parsing finishes, then saves the receipt and replies', async () => {
    let finish;
    parseReceiptFromText.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(GOOD); }));
    const res = makeRes();
    await sms(makeReq({ Body: 'Costco milk 20.80 tax 2.70 total 23.50' }), res);

    expect(res.send).toHaveBeenCalledWith('<Response/>');
    await waitFor(() => finish, 'parse start');
    expect(receipts()).toHaveLength(0);
    finish();
    await waitFor(() => sendSms.mock.calls.length > 0, 'confirmation sms');

    const [[id, doc]] = receipts();
    expect(doc).toMatchObject({ from: FROM, messageSid: 'SM1', merchant: 'Costco', merchantKey: 'costco', total: 23.5, category: 'Grocery', currency: 'CAD' });
    expect(id).toBeTruthy();
    expect(lastSms()).toContain('Saved: Costco — $23.50 (Grocery, 1 item)');
  });

  it('the first receipt gets the onboarding tip and uses the Pro model flag', async () => {
    parseReceiptFromText.mockResolvedValue(GOOD);
    await sms(makeReq({ Body: 'Costco 23.50' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(parseReceiptFromText).toHaveBeenCalledWith('Costco 23.50', true);
    expect(lastSms()).toContain('Tip: Send TOTAL');
  });

  it('a later receipt does not get the first-receipt tip', async () => {
    seed('receipts', 'prev', { from: FROM, messageSid: 'SM0', createdAt: makeTimestamp(new Date(Date.now() - 1000)), merchant: 'Other', total: 1 });
    parseReceiptFromText.mockResolvedValue(GOOD);
    await sms(makeReq({ Body: 'Costco 23.50' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(parseReceiptFromText).toHaveBeenCalledWith('Costco 23.50', false);
    expect(lastSms()).not.toContain('Tip: Send TOTAL');
  });

  it('flags a low-confidence save, a missing date, and a refund', async () => {
    seed('receipts', 'prev', { from: FROM, createdAt: makeTimestamp(new Date()), merchant: 'x', total: 1 });
    parseReceiptFromText.mockResolvedValue({ ...GOOD, confidence: 0.5, date: null, type: 'refund' });
    await sms(makeReq({ Body: 'Costco refund' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toContain('⚠️ Saved Refund: Costco');
    expect(lastSms()).toContain("Couldn't find a date");
    expect(receipts().find(([id]) => id !== 'prev')[1].total).toBe(-23.5);
  });

  it('appends budget status when a budget exists for the category', async () => {
    seed('receipts', 'prev', { from: FROM, createdAt: makeTimestamp(new Date()), merchant: 'x', total: 1 });
    seed('budgets', `${FROM.replace(/\D/g, '')}_grocery`, { from: FROM, category: 'Grocery', limit: 100 });
    parseReceiptFromText.mockResolvedValue(GOOD);
    await sms(makeReq({ Body: 'Costco 23.50' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toContain('Budget: $23.50/$100.00 spent');
  });

  it('does not save a duplicate (same merchant, total and date) and says so', async () => {
    seed('receipts', 'orig', { from: FROM, merchant: 'Costco', merchantKey: 'costco', total: 23.5, date: '2026-10-01', createdAt: makeTimestamp(new Date(Date.now() - 86400000)) });
    parseReceiptFromText.mockResolvedValue(GOOD);
    await sms(makeReq({ Body: 'Costco 23.50' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toBe('Duplicate: Costco — $23.50 was already logged.');
    expect(receipts()).toHaveLength(1);
  });

  it('replies that text which is not a receipt was not saved', async () => {
    parseReceiptFromText.mockResolvedValue({ merchant: null, total: null, items: [] });
    await sms(makeReq({ Body: 'what is the weather' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toMatch(/didn't look like a receipt/);
    expect(receipts()).toHaveLength(0);
    expect(failures()).toHaveLength(0);
  });

  it('asks for a photo or text when the body is empty, and rejects overly long text', async () => {
    await sms(makeReq({ Body: '   ' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length === 1);
    expect(lastSms()).toMatch(/Send me a photo/);
    await sms(makeReq({ MessageSid: 'SM2', Body: 'x'.repeat(config.MAX_BODY_TEXT_LENGTH + 1) }), makeRes());
    await waitFor(() => sendSms.mock.calls.length === 2);
    expect(lastSms()).toMatch(/lot of text/);
    expect(parseReceiptFromText).not.toHaveBeenCalled();
  });
});

describe('happy path: photo', () => {
  const photoBody = { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/1', MediaContentType0: 'image/jpeg' };

  it('fetches the image, parses it, stores it, and saves the receipt with its image path', async () => {
    fetchMedia.mockResolvedValue(imageResponse('jpegbytes'));
    parseReceiptFromBase64.mockResolvedValue(GOOD);
    saveImages.mockResolvedValue(['receipts-temporary/SM1/0.jpg']);
    await sms(makeReq(photoBody), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);

    expect(fetchMedia).toHaveBeenCalledWith('https://api.twilio.com/media/1');
    expect(parseReceiptFromBase64.mock.calls[0][0]).toEqual([{ base64: Buffer.from('jpegbytes').toString('base64'), mimeType: 'image/jpeg' }]);
    expect(receipts()[0][1]).toMatchObject({ merchant: 'Costco', imagePaths: ['receipts-temporary/SM1/0.jpg'], messageSid: 'SM1' });
    expect(lastSms()).toContain('Saved: Costco');
  });

  it('skips unsupported media types and replies when no image is usable', async () => {
    await sms(makeReq({ ...photoBody, MediaContentType0: 'application/pdf' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toMatch(/couldn't read that photo/);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(parseReceiptFromBase64).not.toHaveBeenCalled();
  });

  it('drops an oversized image', async () => {
    fetchMedia.mockResolvedValue({ headers: { get: () => String(config.MAX_IMAGE_SIZE + 1) }, arrayBuffer: async () => Buffer.from('x') });
    await sms(makeReq(photoBody), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toMatch(/couldn't read that photo/);
    expect(parseReceiptFromBase64).not.toHaveBeenCalled();
  });
});

describe('error paths in background processing', () => {
  it('records a processing failure and tells the user when parsing throws (returning user)', async () => {
    seed('receipts', 'prev', { from: FROM, createdAt: makeTimestamp(new Date()), merchant: 'x', total: 1 });
    parseReceiptFromText.mockRejectedValue(new Error('gemini exploded'));
    await sms(makeReq({ Body: 'Costco 23.50' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toMatch(/Couldn't read that receipt/);
    expect(failures()).toHaveLength(1);
    expect(failures()[0][1]).toMatchObject({ from: FROM, messageSid: 'SM1', status: 'failed', error: 'gemini exploded' });
    expect(receipts()).toHaveLength(1);
  });

  it('sends the onboarding message instead when a brand-new user fails', async () => {
    parseReceiptFromText.mockRejectedValue(new Error('nope'));
    await sms(makeReq({ Body: 'Costco 23.50' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(lastSms()).toBe(config.ONBOARDING_MESSAGE);
    expect(failures()).toHaveLength(1);
  });

  it('keeps the photo for retry when processing fails', async () => {
    fetchMedia.mockResolvedValue(imageResponse('jpegbytes'));
    parseReceiptFromBase64.mockRejectedValue(new Error('vision failed'));
    await sms(makeReq({ NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/1', MediaContentType0: 'image/jpeg' }), makeRes());
    await waitFor(() => failures().length > 0 && sendSms.mock.calls.length > 0);
    expect(saveFailedImages).toHaveBeenCalled();
    expect(failures()[0][1]).toMatchObject({ imagePaths: ['receipts-failed/SM1/0.jpg'], numMedia: 1 });
    expect(receipts()).toHaveLength(0);
  });

  it('still saves the receipt when image storage fails (non-fatal)', async () => {
    fetchMedia.mockResolvedValue(imageResponse('jpegbytes'));
    parseReceiptFromBase64.mockResolvedValue(GOOD);
    saveImages.mockRejectedValue(new Error('bucket down'));
    await sms(makeReq({ NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/1', MediaContentType0: 'image/jpeg' }), makeRes());
    await waitFor(() => sendSms.mock.calls.length > 0);
    expect(receipts()[0][1]).toMatchObject({ merchant: 'Costco', imagePaths: [] });
    expect(lastSms()).toContain('Saved: Costco');
  });
});

describe('text commands', () => {
  it('LAST replies with the most recent receipt, and says so when there are none', async () => {
    await sms(makeReq({ Body: 'LAST' }), makeRes());
    expect(lastSms()).toBe('No receipts found.');
    seed('receipts', 'r1', { from: FROM, createdAt: makeTimestamp(new Date()), merchant: 'IKEA', total: 40, date: '2026-10-02', category: 'Home' });
    await sms(makeReq({ MessageSid: 'SM2', Body: 'last' }), makeRes());
    expect(lastSms()).toBe('Last: IKEA — $40.00 on 2026-10-02 (Home)');
  });

  it('BUDGET <category> <limit> stores the budget', async () => {
    await sms(makeReq({ Body: 'BUDGET Grocery 500' }), makeRes());
    expect(lastSms()).toBe('Budget set: Grocery limit is now $500.00.');
    expect([...fake.store.budgets.values()][0]).toMatchObject({ from: FROM, category: 'Grocery', limit: 500 });
  });

  it('a malformed BUDGET command gets a helpful error', async () => {
    await sms(makeReq({ Body: 'BUDGET Grocery lots' }), makeRes());
    expect(lastSms()).toMatch(/That didn't look right/);
    expect(fake.store.budgets?.size || 0).toBe(0);
  });
});
