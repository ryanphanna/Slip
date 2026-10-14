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
  it('gives retryProcessing a long timeout (Gemini parsing can take minutes)', () => {
    require('../index');
    const withOptions = calls.filter((args) => args.length === 2);
    expect(withOptions).toHaveLength(1);
    expect(withOptions[0][0].timeoutSeconds).toBeGreaterThanOrEqual(180);
    expect(config.FUNCTION_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(180);
  });
});
