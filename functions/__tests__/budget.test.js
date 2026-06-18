const admin = require('firebase-admin');
const { setBudget, getBudget, getAllBudgets, getBudgetReport } = require('../lib/budget');

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDoc = jest.fn(() => ({
  set: mockSet,
  get: mockGet,
}));

const mockCollection = jest.fn(() => ({
  doc: mockDoc,
  where: jest.fn().mockReturnThis(),
  get: mockGet,
}));

jest.mock('firebase-admin', () => {
  const firestoreMock = jest.fn(() => ({
    collection: mockCollection,
  }));
  firestoreMock.FieldValue = {
    serverTimestamp: () => 'timestamp',
  };
  return {
    firestore: firestoreMock,
  };
});

describe('budget operations library', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sets a category budget document correctly', async () => {
    mockSet.mockResolvedValue(true);

    const result = await setBudget('+14165551234', 'Grocery', 500);

    expect(result).toEqual({ category: 'Grocery', limit: 500 });
    expect(mockCollection).toHaveBeenCalledWith('budgets');
    expect(mockDoc).toHaveBeenCalledWith('14165551234_grocery');
    expect(mockSet).toHaveBeenCalledWith({
      from: '+14165551234',
      category: 'Grocery',
      limit: 500,
      updatedAt: 'timestamp',
    });
  });

  it('fetches a single budget document', async () => {
    const mockData = { from: '+14165551234', category: 'Grocery', limit: 500 };
    mockGet.mockResolvedValue({
      exists: true,
      data: () => mockData,
    });

    const result = await getBudget('+14165551234', 'Grocery');
    expect(result).toEqual(mockData);
    expect(mockDoc).toHaveBeenCalledWith('14165551234_grocery');
  });

  it('returns null if budget does not exist', async () => {
    mockGet.mockResolvedValue({ exists: false });
    const result = await getBudget('+14165551234', 'Grocery');
    expect(result).toBeNull();
  });
});
