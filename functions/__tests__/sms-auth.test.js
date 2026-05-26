jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((_, handler) => handler),
}));

jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(name => ({
    value: jest.fn(() => process.env[name] || ''),
  })),
}));

jest.mock('firebase-functions/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
}));

jest.mock('../lib/twilio', () => ({
  validateTwilioSignature: jest.fn(),
  sendSms: jest.fn(),
  fetchMedia: jest.fn(),
}));

jest.mock('../lib/receipt', () => ({
  parseReceiptFromBase64: jest.fn(),
  parseReceiptFromText: jest.fn(),
}));

jest.mock('../lib/validate', () => ({
  validateReceipt: jest.fn(),
}));

jest.mock('../lib/store', () => ({
  saveReceipt: jest.fn(),
  findDuplicate: jest.fn(),
  isMessageProcessed: jest.fn(),
  checkRateLimit: jest.fn(),
}));

jest.mock('../lib/query', () => ({
  getMonthlyStats: jest.fn(),
  getLastReceipt: jest.fn(),
}));

jest.mock('../lib/image-store', () => ({
  saveImages: jest.fn(),
}));

jest.mock('../lib/allowlist', () => ({
  isAllowed: jest.fn(),
}));

const { sms } = require('../index');
const { validateTwilioSignature, sendSms } = require('../lib/twilio');
const { isMessageProcessed, checkRateLimit } = require('../lib/store');
const { isAllowed } = require('../lib/allowlist');

function makeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

describe('sms webhook authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_PHONES = '+14165551234';
  });

  afterEach(() => {
    delete process.env.ALLOWED_PHONES;
  });

  it('rejects allowed senders when Twilio signature validation fails', async () => {
    isAllowed.mockReturnValue(true);
    validateTwilioSignature.mockReturnValue(false);

    const req = {
      method: 'POST',
      body: {
        From: '+14165551234',
        MessageSid: 'SM123',
        NumMedia: '0',
        Body: 'LAST',
      },
      headers: {},
    };
    const res = makeResponse();

    await sms(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith('Forbidden');
    expect(isMessageProcessed).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('validates Twilio signature before checking the sender allowlist', async () => {
    isAllowed.mockReturnValue(false);
    validateTwilioSignature.mockReturnValue(false);

    const req = {
      method: 'POST',
      body: {
        From: '+14165550000',
        MessageSid: 'SM456',
        NumMedia: '0',
        Body: 'LAST',
      },
      headers: {},
    };
    const res = makeResponse();

    await sms(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith('Forbidden');
    expect(isAllowed).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });
});
