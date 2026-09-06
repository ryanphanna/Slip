jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(name => ({
    value: jest.fn(() => process.env[name] || ''),
  })),
}));

jest.mock('firebase-functions/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const mockMessagesCreate = jest.fn();
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  // Keep the real signature helpers (pure crypto, no network) but stub the
  // client factory so sendSms doesn't hit the real Twilio API in tests.
  const mockClientFactory = jest.fn(() => ({ messages: { create: mockMessagesCreate } }));
  return Object.assign(mockClientFactory, actual);
});

const twilioLib = require('twilio');
const { buildRequestUrls, parseForwardedValues, validateTwilioSignature, sendSms, fetchMedia } = require('../lib/twilio');


describe('twilio url generation helpers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars before each test
    delete process.env.WEBHOOK_URL;
    delete process.env.K_SERVICE;
    delete process.env.FUNCTION_TARGET;
    delete process.env.FUNCTION_REGION;
    delete process.env.GCLOUD_REGION;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCP_PROJECT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('parseForwardedValues', () => {
    it('returns empty array for missing or invalid input', () => {
      expect(parseForwardedValues(null)).toEqual([]);
      expect(parseForwardedValues(undefined)).toEqual([]);
      expect(parseForwardedValues('')).toEqual([]);
      expect(parseForwardedValues(123)).toEqual([]);
    });

    it('splits comma-separated values and trims whitespace', () => {
      expect(parseForwardedValues('host1.example.com, host2.example.com')).toEqual([
        'host1.example.com',
        'host2.example.com',
      ]);
    });

    it('filters out empty values', () => {
      expect(parseForwardedValues('host1,,host2, ')).toEqual(['host1', 'host2']);
    });
  });

  describe('buildRequestUrls', () => {
    it('generates basic URLs from a minimal request', () => {
      process.env.WEBHOOK_URL = 'https://example.com/webhook';
      process.env.K_SERVICE = 'sms';
      process.env.GCLOUD_PROJECT = 'my-project';

      const req = {
        originalUrl: '/webhook',
        url: '/webhook',
        headers: { host: 'example.com' },
        protocol: 'https',
        get: (h) => (h === 'host' ? 'example.com' : undefined),
      };

      const urls = buildRequestUrls(req);

      expect(urls).toContain('https://example.com/webhook');
      expect(urls).toContain('https://example.com/webhook/');
      expect(urls).toContain('https://us-central1-my-project.cloudfunctions.net/sms');
      expect(urls).toContain('https://us-central1-my-project.cloudfunctions.net/sms/');
    });

    it('includes variants from x-forwarded-host and x-forwarded-proto', () => {
      process.env.WEBHOOK_URL = 'https://primary.example.com/sms';
      process.env.K_SERVICE = 'sms';

      const req = {
        originalUrl: '/sms',
        headers: {
          host: 'internal-host',
          'x-forwarded-host': 'forwarded1.com, forwarded2.com',
          'x-forwarded-proto': 'https, http',
        },
        protocol: 'http',
        get: (h) => req.headers[h.toLowerCase()] || undefined,
      };

      const urls = buildRequestUrls(req);

      // Should include variants for both forwarded hosts
      expect(urls).toContain('https://forwarded1.com/sms');
      expect(urls).toContain('http://forwarded2.com/sms');
      expect(urls).toContain('https://internal-host/sms');
    });

    it('handles paths that do not match the function name', () => {
      process.env.K_SERVICE = 'sms';
      process.env.GCLOUD_PROJECT = 'proj';

      const req = {
        originalUrl: '/custom-path',
        headers: { host: 'example.com' },
        protocol: 'https',
        get: () => 'example.com',
      };

      const urls = buildRequestUrls(req);

      expect(urls).toContain('https://example.com/custom-path');
      expect(urls).toContain('https://example.com/sms'); // the fallback function name path
    });

    it('always includes both slashed and non-slashed versions', () => {
      process.env.WEBHOOK_URL = 'https://example.com/sms';
      process.env.K_SERVICE = 'sms';

      const req = {
        originalUrl: '/sms',
        headers: { host: 'example.com' },
        protocol: 'https',
        get: () => 'example.com',
      };

      const urls = buildRequestUrls(req);

      expect(urls).toContain('https://example.com/sms');
      expect(urls).toContain('https://example.com/sms/');
    });

    it('falls back gracefully when many headers are missing', () => {
      process.env.WEBHOOK_URL = 'https://fallback.example.com';
      process.env.FUNCTION_TARGET = 'myfunc';
      process.env.GCLOUD_PROJECT = 'test-proj';

      const req = {
        headers: { host: 'some-host.internal' },
        protocol: 'https',
        get: (h) => (h === 'host' ? 'some-host.internal' : undefined),
      };

      const urls = buildRequestUrls(req);

      expect(urls.length).toBeGreaterThan(0);
      // Should still generate the function-name fallback path
      expect(urls.some(u => { try { return new URL(u).pathname.startsWith('/myfunc'); } catch { return false; } })).toBe(true);
      // Should also generate the Cloud Functions URL
      expect(urls).toContain('https://us-central1-test-proj.cloudfunctions.net/myfunc');
      expect(urls).toContain('https://us-central1-test-proj.cloudfunctions.net/myfunc/');
    });
  });

  describe('validateTwilioSignature', () => {
    beforeEach(() => {
      process.env.TWILIO_AUTH_TOKEN = 'supersecrettoken';
    });

    afterEach(() => {
      delete process.env.TWILIO_AUTH_TOKEN;
    });

    it('returns false when signature header is missing', () => {
      const req = {
        query: {},
        headers: {},
      };
      expect(validateTwilioSignature(req)).toBe(false);
    });

    it('accepts a signature computed against one of the candidate URLs', () => {
      process.env.WEBHOOK_URL = 'https://example.com/sms';
      const body = { From: '+15551234567', Body: 'hi' };
      const signature = twilioLib.getExpectedTwilioSignature('supersecrettoken', 'https://example.com/sms', body);
      const req = {
        originalUrl: '/sms',
        headers: { host: 'example.com', 'x-twilio-signature': signature },
        protocol: 'https',
        get: () => 'example.com',
        body,
      };
      expect(validateTwilioSignature(req)).toBe(true);
    });

    it('rejects a signature that matches none of the candidate URLs', () => {
      process.env.WEBHOOK_URL = 'https://example.com/sms';
      const req = {
        originalUrl: '/sms',
        headers: { host: 'example.com', 'x-twilio-signature': 'not-a-real-signature==' },
        protocol: 'https',
        get: () => 'example.com',
        body: { From: '+15551234567', Body: 'hi' },
      };
      expect(validateTwilioSignature(req)).toBe(false);
    });
  });
});

describe('sendSms', () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_PHONE_NUMBER = '+15550001111';
    mockMessagesCreate.mockClear();
    mockMessagesCreate.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
  });

  it('sends from the configured Twilio number to the given recipient', async () => {
    await sendSms('+15559998888', 'hello there');
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      body: 'hello there',
      from: '+15550001111',
      to: '+15559998888',
    });
  });
});

describe('fetchMedia (SSRF protections)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    global.fetch = originalFetch;
  });

  it('rejects a media URL on a host outside the Twilio allowlist', async () => {
    await expect(fetchMedia('https://evil.example.com/steal')).rejects.toThrow('Blocked media URL host');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTPS media URL even on an allowed host', async () => {
    await expect(fetchMedia('http://api.twilio.com/media/1')).rejects.toThrow('non-HTTPS protocol');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches an allowed Twilio host with Basic auth and returns the response', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const res = await fetchMedia('https://api.twilio.com/media/1');
    expect(res.ok).toBe(true);
    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers.Authorization).toMatch(/^Basic /);
  });

  it('does not send credentials to a non-Twilio CDN host reached via redirect', async () => {
    global.fetch
      .mockResolvedValueOnce({ status: 302, headers: { get: () => 'https://media.twiliocdn.com/file' } })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await fetchMedia('https://api.twilio.com/media/1');
    const [, secondOptions] = global.fetch.mock.calls[1];
    expect(secondOptions.headers.Authorization).toBeUndefined();
  });

  it('follows a redirect to an allowed CDN host but blocks a redirect off HTTPS', async () => {
    global.fetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: () => 'http://media.twiliocdn.com/file' },
    });
    await expect(fetchMedia('https://api.twilio.com/media/1')).rejects.toThrow('non-HTTPS media redirect');
  });

  it('gives up after too many redirects', async () => {
    global.fetch.mockResolvedValue({ status: 302, headers: { get: () => 'https://media.twiliocdn.com/file' } });
    await expect(fetchMedia('https://api.twilio.com/media/1')).rejects.toThrow('Too many redirects');
  });

  it('throws when the final response is not ok', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchMedia('https://api.twilio.com/media/1')).rejects.toThrow('Failed to fetch Twilio media: 500');
  });
});

