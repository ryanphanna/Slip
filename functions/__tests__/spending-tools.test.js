const admin = require('firebase-admin');
const { executeTool, TOOL_DECLARATIONS } = require('../lib/spending-tools');

const mockGet = jest.fn();
const mockQuery = {
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  get: mockGet,
};

jest.mock('firebase-admin', () => ({
  firestore: jest.fn(() => ({
    collection: jest.fn(() => mockQuery),
  })),
}));

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
});
