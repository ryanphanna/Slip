let mockParamValue = 'true';
const mockScheduled = [];

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((_o, handler) => handler),
  onCall: jest.fn((...args) => args[args.length - 1]),
  HttpsError: class HttpsError extends Error {},
}));
jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((options, handler) => { mockScheduled.push({ options, handler }); return handler; }),
}));
jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(() => ({ value: () => '' })),
  defineString: jest.fn((name, opts) => ({ name, opts, value: () => mockParamValue })),
}));
jest.mock('firebase-functions/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('firebase-admin', () => ({ initializeApp: jest.fn(), firestore: jest.fn(), storage: jest.fn(), auth: jest.fn() }));
jest.mock('../lib/retention', () => ({ purgeOldFailures: jest.fn() }));

const logger = require('firebase-functions/logger');
const { defineString } = require('firebase-functions/params');
const { purgeOldFailures } = require('../lib/retention');
require('../index');

const job = () => mockScheduled.find((s) => s.options.schedule === '30 3 * * *');

beforeEach(() => {
  purgeOldFailures.mockReset();
  purgeOldFailures.mockResolvedValue({ dryRun: true, eligibleRows: 0 });
  logger.info.mockClear();
  logger.error.mockClear();
});

describe('failure retention schedule', () => {
  it('is a daily job, with a parameter that defaults to dry-run', () => {
    expect(job()).toBeTruthy();
    expect(job().options.timeZone).toBe('America/Toronto');
    const call = defineString.mock.calls.find(([name]) => name === 'FAILURE_RETENTION_DRY_RUN');
    expect(call[1]).toEqual({ default: 'true' });
  });

  it('runs as a dry run unless the flag is exactly "false"', async () => {
    for (const value of ['true', 'True', '', 'no', '0', 'FALSE', ' false']) {
      mockParamValue = value;
      purgeOldFailures.mockClear();
      await job().handler();
      expect(purgeOldFailures).toHaveBeenCalledWith({ dryRun: true });
    }
  });

  it('deletes for real only when the flag is "false"', async () => {
    mockParamValue = 'false';
    await job().handler();
    expect(purgeOldFailures).toHaveBeenCalledWith({ dryRun: false });
  });

  it('logs only the counts', async () => {
    mockParamValue = 'true';
    purgeOldFailures.mockResolvedValue({ dryRun: true, eligibleRows: 4, deletedRows: 4, deletedImages: 2, sharedImages: 1, skippedImages: 0, failedRows: 0 });
    await job().handler();
    expect(logger.info).toHaveBeenCalledWith('Failure retention run', { dryRun: true, eligibleRows: 4, deletedRows: 4, deletedImages: 2, sharedImages: 1, skippedImages: 0, failedRows: 0 });
  });

  it('logs and swallows an unexpected error', async () => {
    purgeOldFailures.mockRejectedValue(new Error('index missing'));
    await expect(job().handler()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Failure retention run failed', { error: 'index missing' });
  });
});
