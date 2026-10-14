const { createFakeFirestore } = require('../test-helpers/fake-firestore');

jest.mock('firebase-admin', () => ({ firestore: jest.fn(), storage: jest.fn(), auth: jest.fn() }));
jest.mock('../lib/receipt', () => ({ parseReceiptFromBase64: jest.fn(), parseReceiptFromText: jest.fn() }));

const PHONE = '+14165551111';
process.env.ALLOWED_PHONES = PHONE;

const admin = require('firebase-admin');
const tokens = require('../lib/import-tokens');
const { handleMcp, MAX_BODY_BYTES } = require('../lib/mcp');

let fake;
let getUser;
beforeEach(() => {
  fake = createFakeFirestore();
  getUser = jest.fn(async () => ({ phoneNumber: PHONE }));
  admin.firestore.mockReturnValue(fake.db);
  admin.firestore.FieldValue = fake.db.FieldValue;
  admin.firestore.Timestamp = fake.db.Timestamp;
  admin.auth.mockReturnValue({ getUser });
  jest.clearAllMocks();
});

const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };
const call = (authorization, extra = {}) => handleMcp({
  method: 'POST',
  headers: authorization === undefined ? {} : { authorization },
  body: PING,
  ...extra,
});
const wellFormed = (fill = 'A') => `slip_pat_${fill.repeat(43)}`;
const noIo = () => {
  expect(admin.firestore).not.toHaveBeenCalled();
  expect(admin.auth).not.toHaveBeenCalled();
  expect(getUser).not.toHaveBeenCalled();
};

describe('isWellFormedToken', () => {
  it('accepts exactly what createToken issues', async () => {
    for (let i = 0; i < 20; i++) {
      const { token } = await tokens.createToken({ from: PHONE, uid: `u${i}`, label: 'x' });
      expect(tokens.isWellFormedToken(token)).toBe(true);
      expect(token).toHaveLength(52);
      fake.store.import_tokens.clear();
    }
  });

  it.each([
    [undefined], [null], [''], [42], [{}],
    ['slip_pat_'], ['slip_pat_short'],
    [`slip_pat_${'A'.repeat(42)}`], [`slip_pat_${'A'.repeat(44)}`], [`slip_pat_${'A'.repeat(200)}`],
    [`slip_pat_${'A'.repeat(42)}+`], [`slip_pat_${'A'.repeat(42)}/`], [`slip_pat_${'A'.repeat(42)}=`], [`slip_pat_${'A'.repeat(42)} `], [`slip_pat_${'A'.repeat(42)}\n`],
    [`SLIP_PAT_${'A'.repeat(43)}`], [`sk_live_${'A'.repeat(44)}`], [`${'A'.repeat(52)}`], [` ${wellFormed()}`],
  ])('rejects %j', (value) => {
    expect(tokens.isWellFormedToken(value)).toBe(false);
  });
});

describe('cheap rejection before any I/O', () => {
  it.each([
    ['no Authorization header', undefined],
    ['empty header', ''],
    ['Basic scheme', `Basic ${wellFormed()}`],
    ['bare token with no scheme', wellFormed()],
    ['Bearer with nothing after it', 'Bearer'],
    ['Bearer with only a space', 'Bearer '],
    ['wrong prefix', `Bearer sk_live_${'A'.repeat(43)}`],
    ['too short', 'Bearer slip_pat_abc'],
    ['one char short', `Bearer slip_pat_${'A'.repeat(42)}`],
    ['one char long', `Bearer slip_pat_${'A'.repeat(44)}`],
    ['bad characters', `Bearer slip_pat_${'+'.repeat(43)}`],
    ['two tokens', `Bearer ${wellFormed()} ${wellFormed()}`],
    ['huge header', `Bearer ${'A'.repeat(5000)}`],
  ])('%s -> 401 with no Firestore or Auth call', async (_n, header) => {
    const res = await call(header);
    expect(res.status).toBe(401);
    noIo();
  });

  it('a hundred junk requests cause zero reads', async () => {
    for (let i = 0; i < 100; i++) await call(`Bearer junk-${i}`);
    noIo();
  });

  it('oversized bodies are rejected before auth, by declared size or by actual size', async () => {
    expect((await call(`Bearer ${wellFormed()}`, { rawLength: MAX_BODY_BYTES + 1 })).status).toBe(413);
    const big = { jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(MAX_BODY_BYTES) };
    expect((await handleMcp({ method: 'POST', headers: { authorization: `Bearer ${wellFormed()}` }, body: big })).status).toBe(413);
    // A declared length of 0 (chunked, no content-length) must not bypass the cap.
    expect((await handleMcp({ method: 'POST', headers: {}, body: big, rawLength: 0 })).status).toBe(413);
    noIo();
  });

  it('wrong methods are turned away without I/O', async () => {
    expect((await handleMcp({ method: 'GET', headers: {}, body: {} })).status).toBe(405);
    noIo();
  });
});

describe('no oracle: every bad credential gets the identical 401', () => {
  it('missing, malformed, unknown (well-formed), revoked and de-listed tokens look the same', async () => {
    const live = await tokens.createToken({ from: PHONE, uid: 'ua', label: 'live' });
    const revoked = await tokens.createToken({ from: PHONE, uid: 'ub', label: 'revoked' });
    await tokens.revokeToken(PHONE, revoked.id);
    const results = [
      await call(undefined),
      await call('Bearer nonsense'),
      await call(`Bearer ${wellFormed('Z')}`),          // well-formed but unknown: hits Firestore
      await call(`Bearer ${revoked.token}`),            // revoked
    ];
    process.env.ALLOWED_PHONES = '+19999999999';        // live token's owner no longer allowed
    results.push(await call(`Bearer ${live.token}`));
    process.env.ALLOWED_PHONES = PHONE;
    getUser.mockResolvedValueOnce({ phoneNumber: '+19998887777' }); // phone changed on the Firebase user
    results.push(await call(`Bearer ${live.token}`));

    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0].status).toBe(401);
    expect(results[0].headers).toEqual({ 'WWW-Authenticate': 'Bearer realm="slip"' });
    expect(results[0].body.error.message).toBe('Invalid or revoked token');
  });
});

describe('valid tokens are unaffected', () => {
  it('a real token still authenticates, case-insensitive scheme and extra spaces included', async () => {
    const { token } = await tokens.createToken({ from: PHONE, uid: 'ua', label: 'x' });
    for (const header of [`Bearer ${token}`, `bearer ${token}`, `BEARER   ${token}`]) {
      const res = await call(header);
      expect(res.status).toBe(200);
      expect(res.body.result).toEqual({});
    }
    expect(getUser).toHaveBeenCalled();
  });

  it('the capitalised Authorization header name is honoured', async () => {
    const { token } = await tokens.createToken({ from: PHONE, uid: 'ua', label: 'x' });
    const res = await handleMcp({ method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: PING });
    expect(res.status).toBe(200);
  });

  it('a body just under the limit still works', async () => {
    const { token } = await tokens.createToken({ from: PHONE, uid: 'ua', label: 'x' });
    const res = await call(`Bearer ${token}`, { rawLength: MAX_BODY_BYTES });
    expect(res.status).toBe(200);
  });
});
