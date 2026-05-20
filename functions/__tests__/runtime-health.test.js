const {
  readConfigValue,
  getAllowedPhoneCount,
  maskWebhookHost,
  summarizeRuntimeHealth,
} = require('../lib/runtime-health');

describe('runtime health helpers', () => {
  afterEach(() => {
    delete process.env.TEST_ENV_ONLY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ALLOWED_PHONES;
    delete process.env.WEBHOOK_URL;
  });

  it('prefers env values before secret params', () => {
    process.env.TEST_ENV_ONLY = 'env-value';
    const secret = { value: () => 'secret-value' };
    expect(readConfigValue('TEST_ENV_ONLY', secret)).toEqual({
      value: 'env-value',
      source: 'env',
    });
  });

  it('counts allowlisted phones and masks webhook host', () => {
    expect(getAllowedPhoneCount('+1,+2,+3')).toBe(3);
    expect(maskWebhookHost('https://sms.example.com/path')).toBe('sms.example.com');
    expect(maskWebhookHost('not-a-url')).toBe('invalid');
  });

  it('summarizes runtime health without leaking secret values', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'secret';
    process.env.TWILIO_PHONE_NUMBER = '+15551234567';
    process.env.GEMINI_API_KEY = 'gemini';
    process.env.ALLOWED_PHONES = '+15551234567,+15557654321';
    process.env.WEBHOOK_URL = 'https://sms.example.com';

    const summary = summarizeRuntimeHealth();
    expect(summary.hasTwilioAccountSid).toBe(true);
    expect(summary.hasTwilioAuthToken).toBe(true);
    expect(summary.hasTwilioPhoneNumber).toBe(true);
    expect(summary.hasGeminiApiKey).toBe(true);
    expect(summary.allowedPhoneCount).toBe(2);
    expect(summary.webhookHost).toBe('sms.example.com');
    expect(summary.allowedPhonesSource).toBe('env');
    expect(summary.webhookUrlSource).toBe('env');
  });
});
