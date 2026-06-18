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

jest.mock('../lib/budget', () => ({
  setBudget: jest.fn(),
  getBudget: jest.fn(),
  getBudgetReport: jest.fn(),
}));

const { sms } = require('../index');
const { validateTwilioSignature, sendSms } = require('../lib/twilio');
const { isMessageProcessed, checkRateLimit } = require('../lib/store');
const { isAllowed } = require('../lib/allowlist');
const { getLastReceipt } = require('../lib/query');
const { parseReceiptFromText } = require('../lib/receipt');
const { setBudget, getBudget, getBudgetReport } = require('../lib/budget');

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

  it('rejects requests when Twilio signature validation fails even if the sender is allowlisted', async () => {
    isAllowed.mockReturnValue(true);
    validateTwilioSignature.mockReturnValue(false);

    const req = {
      method: 'POST',
      body: {
        From: '+14165551234',
        MessageSid: 'SM123',
        NumMedia: '0',
        Body: ' ',
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


  it('still rejects unlisted senders when the Twilio signature fails', async () => {
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
    expect(isAllowed).toHaveBeenCalledWith('+14165550000');
    expect(sendSms).not.toHaveBeenCalled();
  });

  describe('onboarding and greetings', () => {
    it('sends welcome onboarding message for greetings (e.g. HELLO)', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'HELLO',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining('Welcome to Slip! 🧾')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });

    it('sends welcome onboarding message on parsing failure if user has 0 receipts', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      parseReceiptFromText.mockRejectedValue(new Error('Parsing failed'));
      getLastReceipt.mockResolvedValue(null);

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'some random non-receipt text',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining('Welcome to Slip! 🧾')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });

    it('sends normal parsing failure message if user has existing receipts', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      parseReceiptFromText.mockRejectedValue(new Error('Parsing failed'));
      getLastReceipt.mockResolvedValue({ total: 10 });

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'some random non-receipt text',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining("Couldn't read that receipt.")
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });
  });

  describe('budget commands', () => {
    it('handles BUDGET query command', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      getBudgetReport.mockResolvedValue([
        { category: 'Grocery', limit: 500, spent: 120.5, percentage: 24 },
      ]);

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'BUDGET',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining('Monthly Budgets:\nGrocery: $120.50 / $500.00 (24%)')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });

    it('handles BUDGET set command', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      setBudget.mockResolvedValue({ category: 'Grocery', limit: 500 });

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'BUDGET Grocery 500',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(setBudget).toHaveBeenCalledWith('+14165551234', 'Grocery', 500);
      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining('Budget set: Grocery limit is now $500.00.')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });
  });
});
