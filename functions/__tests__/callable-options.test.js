const calls = [];
jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((_o, handler) => handler),
  onCall: jest.fn((...args) => { calls.push(args); return args[args.length - 1]; }),
  HttpsError: class HttpsError extends Error {},
}));
jest.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: jest.fn((_o, h) => h) }));
jest.mock('firebase-functions/params', () => ({ defineSecret: jest.fn(() => ({ value: () => '' })) }));
jest.mock('firebase-functions/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('firebase-admin', () => ({ initializeApp: jest.fn(), firestore: jest.fn(), storage: jest.fn(), auth: jest.fn() }));

const config = require('../lib/config');

describe('callable options', () => {
  beforeAll(() => { jest.isolateModules(() => require('../index')); });

  it('binds the ALLOWED_PHONES secret on every web callable and the mcp endpoint', () => {
    expect(calls.length).toBeGreaterThanOrEqual(16);
    for (const args of calls) expect(args[0].secrets).toHaveLength(1);
    const https = require('firebase-functions/v2/https');
    expect(https.onRequest.mock.calls.every(([opts]) => Array.isArray(opts?.secrets) && opts.secrets.length >= 1)).toBe(true);
  });

  it('gives retryProcessing a long timeout (Gemini parsing can take minutes)', () => {
    const withTimeout = calls.filter((args) => args[0].timeoutSeconds);
    expect(withTimeout).toHaveLength(1);
    expect(withTimeout[0][0].timeoutSeconds).toBeGreaterThanOrEqual(180);
    expect(config.FUNCTION_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(180);
  });
});
