jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  firestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn(),
        })),
      })),
    })),
  })),
}));

jest.mock('../lib/admin', () => ({
  initializeAdminApp: jest.fn(),
}));

jest.mock('../lib/twilio', () => ({
  fetchMedia: jest.fn(),
}));

jest.mock('../lib/receipt', () => ({
  parseReceiptFromBase64: jest.fn(),
}));

jest.mock('../lib/validate', () => ({
  validateReceipt: jest.fn(),
}));

jest.mock('../lib/store', () => ({
  saveReceipt: jest.fn(),
  findDuplicate: jest.fn(),
}));

jest.mock('../lib/image-store', () => ({
  saveImages: jest.fn(),
}));

const {
  parseArgs,
  shouldConsiderMessage,
  buildSummaryLine,
} = require('../scripts/replay');

describe('replay helpers', () => {
  it('parses replay flags', () => {
    const args = parseArgs(['--limit', '25', '--since', '2026-05-01', '--from', '+1, +2', '--notify']);

    expect(args).toEqual({
      limit: 25,
      since: '2026-05-01',
      from: ['+1', '+2'],
      notify: true,
    });
  });

  it('filters inbound media messages by sender and date', () => {
    const message = {
      direction: 'inbound',
      from: '+14165551234',
      numMedia: '2',
      dateCreated: '2026-06-01T00:00:00.000Z',
    };

    expect(shouldConsiderMessage(message, ['+14165551234'], Date.parse('2026-05-01T00:00:00.000Z'))).toBe(true);
    expect(shouldConsiderMessage(message, ['+14165550000'], Date.parse('2026-05-01T00:00:00.000Z'))).toBe(false);
    expect(shouldConsiderMessage({ ...message, numMedia: '0' }, ['+14165551234'], Date.parse('2026-05-01T00:00:00.000Z'))).toBe(false);
  });

  it('builds a concise summary line', () => {
    expect(buildSummaryLine({ merchant: 'Target', total: 19.99, category: 'Grocery' }))
      .toBe('Target — $19.99 (Grocery)');
  });
});
