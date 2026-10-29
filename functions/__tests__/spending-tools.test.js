const admin = require('firebase-admin');
const { executeTool, TOOL_DECLARATIONS } = require('../lib/spending-tools');

const mockGet = jest.fn();
const mockDocSet = jest.fn();
const mockDocGet = jest.fn();
const mockDoc = jest.fn(() => ({ set: mockDocSet, get: mockDocGet }));
const mockQuery = {
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  doc: mockDoc,
  get: mockGet,
};

jest.mock('firebase-admin', () => {
  const firestoreMock = jest.fn(() => ({
    collection: jest.fn(() => mockQuery),
  }));
  firestoreMock.FieldValue = { serverTimestamp: () => 'timestamp' };
  return { firestore: firestoreMock };
});

describe('spending-tools helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockDocs = [
    {
      merchant: 'Walmart',
      total: 25.5,
      category: 'Grocery',
      subCategory: 'Supermarket',
      createdAt: { toDate: () => new Date('2026-06-10T12:00:00Z') },
      items: [{ name: 'Milk', price: 5.5 }, { name: 'Bread', price: 2.0 }],
    },
    {
      merchant: 'IKEA',
      total: 120.0,
      category: 'Home',
      subCategory: 'Furniture',
      createdAt: { toDate: () => new Date('2026-06-15T12:00:00Z') },
      items: [{ name: 'Desk lamp', price: 45.0 }],
    },
    {
      merchant: 'Shoppers Drug Mart',
      total: 15.0,
      category: 'Health',
      createdAt: { toDate: () => new Date('2026-06-16T12:00:00Z') },
      items: [{ name: 'Advil', price: 15.0 }],
    },
  ];

  it('declares searchReceipts in TOOL_DECLARATIONS', () => {
    const searchTool = TOOL_DECLARATIONS.find(t => t.name === 'searchReceipts');
    expect(searchTool).toBeDefined();
    expect(searchTool.parameters.properties.query).toBeDefined();
  });

  it('calculates spending total with and without filters', async () => {
    mockGet.mockResolvedValue({
      docs: mockDocs.map(d => ({ data: () => d })),
    });

    // 1. Without filters
    let result = await executeTool('getSpendingTotal', {});
    expect(result.total).toBe(160.5);
    expect(result.receiptCount).toBe(3);

    // 2. Filter by merchant
    result = await executeTool('getSpendingTotal', { merchant: 'Ikea' });
    expect(result.total).toBe(120.0);
    expect(result.receiptCount).toBe(1);

    // 3. Filter by category
    result = await executeTool('getSpendingTotal', { category: 'Health' });
    expect(result.total).toBe(15.0);
    expect(result.receiptCount).toBe(1);
  });

  it('filters date ranges on the printed date, falling back to the sent date', async () => {
    const docs = [
      { merchant: 'Late', total: 40, category: 'Grocery', date: '2026-05-30', createdAt: { toDate: () => new Date('2026-06-02T12:00:00Z') } },
      { merchant: 'June', total: 10, category: 'Grocery', date: '2026-06-30', createdAt: { toDate: () => new Date('2026-07-01T12:00:00Z') } },
      { merchant: 'Undated', total: 7, category: 'Dining', date: null, createdAt: { toDate: () => new Date('2026-06-10T12:00:00Z') } },
    ];
    mockGet.mockResolvedValue({ docs: docs.map(d => ({ data: () => d })) });

    const june = await executeTool('getSpendingTotal', { startDate: '2026-06-01', endDate: '2026-06-30' });
    expect(june).toMatchObject({ total: 17, receiptCount: 2 });
    const summary = await executeTool('getMonthlySummary', { year: 2026, month: 6 });
    expect(summary.total).toBe(17);
  });

  it('calculates spending by category with merchant filter', async () => {
    mockGet.mockResolvedValue({
      docs: mockDocs.map(d => ({ data: () => d })),
    });

    const result = await executeTool('getSpendingByCategory', { merchant: 'Walmart' });
    expect(result.total).toBe(25.5);
    expect(result.categories).toEqual([{ category: 'Grocery', amount: 25.5 }]);
  });

  it('searches receipts by text query and amount ranges', async () => {
    mockGet.mockResolvedValue({
      docs: mockDocs.map(d => ({ data: () => d })),
    });

    // Search by item name
    let result = await executeTool('searchReceipts', { query: 'lamp' });
    expect(result).toHaveLength(1);
    expect(result[0].merchant).toBe('IKEA');

    // Search by amount range
    result = await executeTool('searchReceipts', { minAmount: 20, maxAmount: 100 });
    expect(result).toHaveLength(1);
    expect(result[0].merchant).toBe('Walmart');
  });

  it('aggregates spending by item categories for mixed receipts', async () => {
    const mixedDocs = [
      {
        merchant: 'Walmart',
        total: 100.0,
        category: 'Grocery',
        createdAt: { toDate: () => new Date('2026-06-12T12:00:00Z') },
        items: [
          { name: 'Apples', price: 10.0, category: 'Grocery' },
          { name: 'Advil', price: 15.0, category: 'Health' },
          { name: 'Sofa Pillow', price: 25.0, category: 'Home' },
          { name: 'Shirt', price: 30.0, category: 'Shopping' },
        ],
      },
    ];

    mockGet.mockResolvedValue({
      docs: mixedDocs.map(d => ({ data: () => d })),
    });

    const result = await executeTool('getSpendingByCategory', {});

    expect(result.total).toBe(100.0);
    expect(result.categories).toEqual(expect.arrayContaining([
      { category: 'Grocery', amount: 30.0 },
      { category: 'Health', amount: 15.0 },
      { category: 'Home', amount: 25.0 },
      { category: 'Shopping', amount: 30.0 },
    ]));
  });

  it('identifies and aggregates recurring subscriptions', async () => {
    const subDocs = [
      {
        merchant: 'Netflix',
        total: 19.99,
        category: 'Entertainment',
        isSubscription: true,
        currency: 'CAD',
        createdAt: { toDate: () => new Date('2026-06-01T12:00:00Z') },
      },
      {
        merchant: 'Spotify',
        total: 10.99,
        category: 'Entertainment',
        isSubscription: true,
        currency: 'CAD',
        createdAt: { toDate: () => new Date('2026-06-02T12:00:00Z') },
      },
      {
        merchant: 'Netflix',
        total: 19.99,
        category: 'Entertainment',
        isSubscription: true,
        currency: 'CAD',
        createdAt: { toDate: () => new Date('2026-05-01T12:00:00Z') },
      },
    ];

    mockGet.mockResolvedValue({
      docs: subDocs.map(d => ({ data: () => d })),
    });

    const result = await executeTool('getSubscriptions', {});

    expect(result.totalMonthlyOverhead).toBe(30.98);
    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ merchant: 'Netflix', amount: 19.99, lastBilled: '2026-06-01' }),
      expect.objectContaining({ merchant: 'Spotify', amount: 10.99, lastBilled: '2026-06-02' }),
    ]));
  });

  it('ranks top merchants by total spend and respects the limit', async () => {
    mockGet.mockResolvedValue({ docs: mockDocs.map(d => ({ data: () => d })) });
    const result = await executeTool('getTopMerchants', { limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ merchant: 'IKEA', total: 120.0, visits: 1 });
  });

  it('combines repeat visits to the same normalized merchant', async () => {
    const repeatDocs = [
      { merchant: 'walmart', total: 10, createdAt: { toDate: () => new Date() } },
      { merchant: 'Wal-Mart', total: 20, createdAt: { toDate: () => new Date() } },
    ];
    mockGet.mockResolvedValue({ docs: repeatDocs.map(d => ({ data: () => d })) });
    const result = await executeTool('getTopMerchants', {});
    expect(result).toEqual([{ merchant: 'Walmart', total: 30, visits: 2 }]);
  });

  it('returns recent receipts filtered by merchant, capped at the requested limit', async () => {
    mockGet.mockResolvedValue({ docs: mockDocs.map(d => ({ data: () => d })) });
    const result = await executeTool('getRecentReceipts', { merchant: 'ikea', limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0].merchant).toBe('IKEA');
  });

  it('summarizes a calendar month with top merchants and category breakdown', async () => {
    mockGet.mockResolvedValue({ docs: mockDocs.map(d => ({ data: () => d })) });
    const result = await executeTool('getMonthlySummary', { year: 2026, month: 6 });
    expect(result.total).toBe(160.5);
    expect(result.monthName).toBe('June');
    expect(result.topMerchants[0]).toEqual({ merchant: 'IKEA', amount: 120.0 });
  });
});

describe('executeTool dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes setCategoryBudget to a budget write', async () => {
    mockDocSet.mockResolvedValue(true);
    const result = await executeTool('setCategoryBudget', { category: 'Grocery', limit: 300 });
    expect(result).toEqual({ category: 'Grocery', limit: 300 });
    expect(mockDocSet).toHaveBeenCalled();
  });

  it('routes getBudgetStatus to a budget report', async () => {
    mockGet.mockResolvedValue({ docs: [] });
    const result = await executeTool('getBudgetStatus', {});
    expect(result).toEqual([]);
  });

  it('throws for an unrecognized tool name', async () => {
    await expect(executeTool('notARealTool', {})).rejects.toThrow('Unknown tool: notARealTool');
  });
});

describe('spending tools with mixed currencies', () => {
  const docs = [
    { merchant: 'Costco', total: 100, category: 'Grocery', createdAt: { toDate: () => new Date() } },
    { merchant: 'Costco', total: 60, category: 'Grocery', currency: 'USD', createdAt: { toDate: () => new Date() } },
    { merchant: 'Target', total: 999, category: 'Shopping', currency: 'USD', createdAt: { toDate: () => new Date() } },
  ];
  beforeEach(() => { mockGet.mockResolvedValue({ docs: docs.map((d) => ({ data: () => d })) }); });

  it('getSpendingTotal reports CAD and other currencies separately', async () => {
    const r = await executeTool('getSpendingTotal', {});
    expect(r).toMatchObject({ total: 100, receiptCount: 1, currency: 'CAD' });
    expect(r.byCurrency).toEqual({ USD: { total: 1059, receiptCount: 2 } });
  });

  it('getTopMerchants ranks CAD only', async () => {
    const r = await executeTool('getTopMerchants', {});
    expect(r).toEqual([{ merchant: 'Costco', total: 100, visits: 1 }]);
  });

  it('getSpendingByCategory and monthly summary keep currencies apart', async () => {
    const byCat = await executeTool('getSpendingByCategory', {});
    expect(byCat.total).toBe(100);
    expect(byCat.byCurrency.USD.total).toBe(1059);
    const monthly = await executeTool('getMonthlySummary', {});
    expect(monthly.total).toBe(100);
    expect(monthly.topMerchants).toEqual([{ merchant: 'Costco', amount: 100 }]);
    expect(monthly.byCurrency.USD.total).toBe(1059);
  });
});

