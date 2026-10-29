jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((_, handler) => handler),
  onCall: jest.fn(handler => handler),
  HttpsError: class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  },
}));

jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(name => ({
    value: jest.fn(() => process.env[name] || ''),
  })),
  defineString: jest.fn((_n, opts) => ({ value: () => (opts && opts.default) || '' })),
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
  photoReadNothing: (raw) => !raw || (raw.merchant == null && raw.total == null && (!Array.isArray(raw.items) || raw.items.length === 0)), groupReceiptPhotos: jest.fn(async (images) => [images.map((_, i) => i)]),
}));

jest.mock('../lib/validate', () => ({
  validateReceipt: jest.fn(),
  dateLooksWrong: jest.fn(() => false),
  totalsLookWrong: jest.fn(() => false),
  itemsLookMissing: jest.fn(() => false),
}));

jest.mock('../lib/store', () => ({
  saveReceipt: jest.fn(),
  findDuplicate: jest.fn(),
  findPossibleDuplicate: jest.fn(),
  isMessageProcessed: jest.fn(),
  checkRateLimit: jest.fn(),
}));

jest.mock('../lib/query', () => ({
  getMonthlyStats: jest.fn(),
  getLastReceipt: jest.fn(),
  getSpendingStats: jest.fn(),
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
  getBudgetStatus: jest.fn(),
}));

const { sms } = require('../index');
const { validateTwilioSignature, sendSms } = require('../lib/twilio');
const { isMessageProcessed, checkRateLimit } = require('../lib/store');
const { isAllowed } = require('../lib/allowlist');
const { getLastReceipt, getSpendingStats, getMonthlyStats } = require('../lib/query');
const { parseReceiptFromText } = require('../lib/receipt');
const { setBudget, getBudget, getBudgetReport, getBudgetStatus } = require('../lib/budget');

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
    checkRateLimit.mockResolvedValue({ exceeded: false });
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

  it('rejects requests when hourly rate limit is exceeded', async () => {
    isAllowed.mockReturnValue(true);
    validateTwilioSignature.mockReturnValue(true);
    checkRateLimit.mockResolvedValue({ exceeded: true, reason: 'hourly' });

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

    expect(sendSms).toHaveBeenCalledWith(
      '+14165551234',
      expect.stringContaining("hit the hourly limit")
    );
    expect(res.send).toHaveBeenCalledWith('<Response/>');
  });

  it('rejects requests when daily rate limit is exceeded', async () => {
    isAllowed.mockReturnValue(true);
    validateTwilioSignature.mockReturnValue(true);
    checkRateLimit.mockResolvedValue({ exceeded: true, reason: 'daily' });

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

    expect(sendSms).toHaveBeenCalledWith(
      '+14165551234',
      expect.stringContaining("hit your daily limit")
    );
    expect(res.send).toHaveBeenCalledWith('<Response/>');
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
      await new Promise(resolve => setImmediate(resolve));

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
      await new Promise(resolve => setImmediate(resolve));

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining("Couldn't read that receipt.")
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });
  });

  describe('multi-currency replies', () => {
    const send = async (body) => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      const res = makeResponse();
      await sms({ method: 'POST', body: { From: '+14165551234', MessageSid: 'SM9', NumMedia: '0', Body: body }, headers: {} }, res);
      return sendSms.mock.calls.at(-1)[1];
    };

    it('TOTAL shows CAD headline and a separate "Also spent" line', async () => {
      getSpendingStats.mockResolvedValue({ total: 120.5, count: 4, byCurrency: { USD: { total: 45, count: 2 }, EUR: { total: 30, count: 1 } } });
      getBudgetReport.mockResolvedValue([{ limit: 100 }]);
      const msg = await send('TOTAL MONTH');
      expect(msg).toContain('$120.50 (4 receipts)\nAlso spent: EUR 30.00 (1 receipt), US$45.00 (2 receipts)');
    });

    it('SUMMARY lists CAD categories, then the other currencies', async () => {
      getMonthlyStats.mockResolvedValue({ month: 'October', total: 80, categories: { Grocery: 80 }, count: 2, byCurrency: { USD: { total: 45, count: 2 } } });
      const msg = await send('SUMMARY');
      expect(msg).toBe('October Summary:\nGrocery: $80.00\n\nTotal: $80.00\n\nAlso spent: US$45.00 (2 receipts)');
    });

    it('SUMMARY is unchanged when everything is CAD', async () => {
      getMonthlyStats.mockResolvedValue({ month: 'October', total: 80, categories: { Grocery: 80 }, count: 2 });
      expect(await send('SUMMARY')).toBe('October Summary:\nGrocery: $80.00\n\nTotal: $80.00');
    });

    it('LAST formats the receipt in its own currency', async () => {
      getLastReceipt.mockResolvedValue({ merchant: 'Target', total: 45, currency: 'USD', date: '2026-10-01', category: 'Shopping' });
      expect(await send('LAST')).toBe('Last: Target — US$45.00 on 2026-10-01 (Shopping)');
      getLastReceipt.mockResolvedValue({ merchant: 'Costco', total: 12.5, date: '2026-10-01', category: 'Grocery' });
      expect(await send('LAST')).toBe('Last: Costco — $12.50 on 2026-10-01 (Grocery)');
    });

    it('BUDGET notes non-CAD spend is not counted', async () => {
      getBudgetStatus.mockResolvedValue({ report: [{ category: 'Grocery', limit: 500, spent: 120.5, percentage: 24 }], otherSpend: { USD: { total: 45, count: 2 } } });
      expect(await send('BUDGET')).toBe('Monthly Budgets:\nGrocery: $120.50 / $500.00 (24%)\n\nAlso spent: US$45.00 (not counted in budgets)');
    });
  });

  describe('budget commands', () => {
    it('handles BUDGET query command', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      getBudgetStatus.mockResolvedValue({
        report: [{ category: 'Grocery', limit: 500, spent: 120.5, percentage: 24 }],
        otherSpend: {},
      });

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

  describe('progressive onboarding and tips', () => {
    it('sends simple onboarding welcome message for greeting keywords', async () => {
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

    it('sends commands list for command keywords like INFO', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'INFO',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining('Slip Commands:')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });

    it('appends budget tip on TOTAL command if user has no budgets', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      getSpendingStats.mockResolvedValue({ total: 150.0, count: 5 });
      getBudgetReport.mockResolvedValue([]); // No budgets set

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'TOTAL',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining('💡 Tip: Send BUDGET Grocery 500 to set category-specific budgets.')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });

    it('does not append budget tip on TOTAL command if user has active budgets', async () => {
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      getSpendingStats.mockResolvedValue({ total: 150.0, count: 5 });
      getBudgetReport.mockResolvedValue([
        { category: 'Grocery', limit: 500, spent: 100, percentage: 20 }
      ]);

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'TOTAL',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);

      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.not.stringContaining('💡 Tip: Send BUDGET Grocery 500')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });

    it('appends first receipt tip when a new user logs their first receipt successfully', async () => {
      const { parseReceiptFromText } = require('../lib/receipt');
      const { validateReceipt, saveReceipt, findDuplicate } = require('../lib/store');
      
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      isMessageProcessed.mockResolvedValue(false);
      checkRateLimit.mockResolvedValue({ exceeded: false });
      
      getLastReceipt.mockResolvedValue(null); // First receipt!
      parseReceiptFromText.mockResolvedValue({ merchant: 'Walmart', total: 23.14, category: 'Grocery', confidence: 0.95 });
      const { validateReceipt: vrMock } = require('../lib/validate');
      vrMock.mockReturnValue({ merchant: 'Walmart', total: 23.14, category: 'Grocery', confidence: 0.95, items: [] });
      findDuplicate.mockResolvedValue(null);
      getBudget.mockResolvedValue(null); // No budgets

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'Walmart receipt total 23.14',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);
      await new Promise(resolve => setImmediate(resolve)); // Wait for background processing IIFE

      expect(parseReceiptFromText).toHaveBeenCalledWith(
        'Walmart receipt total 23.14',
        true
      );
      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.stringContaining('💡 Tip: Send TOTAL to see your monthly spend, or INFO for all commands.')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });

    it('does not append first receipt tip when an existing user logs a receipt', async () => {
      const { parseReceiptFromText } = require('../lib/receipt');
      const { validateReceipt, saveReceipt, findDuplicate } = require('../lib/store');
      
      isAllowed.mockReturnValue(true);
      validateTwilioSignature.mockReturnValue(true);
      isMessageProcessed.mockResolvedValue(false);
      checkRateLimit.mockResolvedValue({ exceeded: false });
      
      getLastReceipt.mockResolvedValue({ merchant: 'Target', total: 10.00 }); // Existing receipt!
      parseReceiptFromText.mockResolvedValue({ merchant: 'Walmart', total: 23.14, category: 'Grocery', confidence: 0.95 });
      const { validateReceipt: vrMock } = require('../lib/validate');
      vrMock.mockReturnValue({ merchant: 'Walmart', total: 23.14, category: 'Grocery', confidence: 0.95, items: [] });
      findDuplicate.mockResolvedValue(null);
      getBudget.mockResolvedValue(null); // No budgets

      const req = {
        method: 'POST',
        body: {
          From: '+14165551234',
          MessageSid: 'SM123',
          NumMedia: '0',
          Body: 'Walmart receipt total 23.14',
        },
        headers: {},
      };
      const res = makeResponse();

      await sms(req, res);
      await new Promise(resolve => setImmediate(resolve)); // Wait for background processing IIFE

      expect(parseReceiptFromText).toHaveBeenCalledWith(
        'Walmart receipt total 23.14',
        false
      );
      expect(sendSms).toHaveBeenCalledWith(
        '+14165551234',
        expect.not.stringContaining('💡 Tip: Send TOTAL to see your monthly spend, or INFO for all commands.')
      );
      expect(res.send).toHaveBeenCalledWith('<Response/>');
    });
  });
});
