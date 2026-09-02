const mockGet = jest.fn();
const mockLimit = jest.fn(() => ({ get: mockGet }));
const mockOrderBy = jest.fn(() => ({ limit: mockLimit }));
const mockWhere = jest.fn(() => ({ where: mockWhere, orderBy: mockOrderBy, get: mockGet }));
const mockCollection = jest.fn(() => ({ where: mockWhere }));

jest.mock('firebase-admin', () => ({
  firestore: jest.fn(() => ({
    collection: mockCollection,
  })),
}));

const { getLastReceipt, getLastMonthStats } = require('../lib/query');

describe('receipt queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads the latest receipt for the sender directly', async () => {
    const latestReceipt = { merchant: 'FreshCo', from: '+14165551234' };
    mockGet.mockResolvedValue({
      empty: false,
      docs: [{ data: () => latestReceipt }],
    });

    await expect(getLastReceipt('+14165551234')).resolves.toBe(latestReceipt);
    expect(mockCollection).toHaveBeenCalledWith('receipts');
    expect(mockWhere).toHaveBeenCalledWith('from', '==', '+14165551234');
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(mockLimit).toHaveBeenCalledWith(1);
  });

  it('returns null when the sender has no receipts', async () => {
    mockGet.mockResolvedValue({ empty: true, docs: [] });

    await expect(getLastReceipt('+14165550000')).resolves.toBeNull();
  });

  it('uses the receipt purchase date for the monthly recap', async () => {
    mockGet.mockResolvedValue({
      docs: [
        { data: () => ({ date: '2026-08-12', total: 12, category: 'Grocery' }) },
      ],
    });

    await expect(getLastMonthStats('+14165551234')).resolves.toEqual({
      total: 12,
      categories: { Grocery: 12 },
      count: 1,
      month: 'August',
      monthKey: '2026-08',
    });
    expect(mockWhere).toHaveBeenCalledWith('from', '==', '+14165551234');
  });
});
