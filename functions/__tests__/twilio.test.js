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

const { buildRequestUrls, parseForwardedValues, validateTwilioSignature } = require('../lib/twilio');


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
  });
});

