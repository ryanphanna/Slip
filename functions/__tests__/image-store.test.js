jest.mock('firebase-admin', () => {
  const saveMock = jest.fn();
  const fileMock = jest.fn(() => ({
    save: saveMock,
  }));
  const bucketMock = jest.fn(() => ({
    file: fileMock,
  }));
  return {
    storage: () => ({
      bucket: bucketMock,
    }),
    __mocks: {
      saveMock,
      fileMock,
      bucketMock,
    },
  };
});

const admin = require('firebase-admin');
const { saveImages, saveFailedImages } = require('../lib/image-store');
const { localDateString } = require('../lib/validate');

// A receipt with a recent date and an item, so nothing about it needs checking.
const READ_OK = { date: localDateString(), items: [{ name: 'A', price: 10 }] };

describe('image-store helper', () => {
  beforeEach(() => {
    admin.__mocks.saveMock.mockClear();
    admin.__mocks.fileMock.mockClear();
    admin.__mocks.bucketMock.mockClear();
  });

  it('routes to temporary prefix by default (low total, high confidence)', async () => {
    const images = [
      { base64: 'abc', mimeType: 'image/png' },
    ];
    const messageSid = 'SM123';
    const receipt = {
      ...READ_OK,
      total: 25.5,
      category: 'Grocery',
      confidence: 0.95,
      merchant: 'Walmart',
    };

    const paths = await saveImages(images, messageSid, receipt);

    expect(paths).toEqual(['receipts-temporary/SM123/0.png']);
    expect(admin.__mocks.fileMock).toHaveBeenCalledWith('receipts-temporary/SM123/0.png');
    expect(admin.__mocks.saveMock).toHaveBeenCalledWith(
      Buffer.from('abc', 'base64'),
      { metadata: { contentType: 'image/png' } }
    );
  });

  it('routes to permanent prefix for high total', async () => {
    const images = [
      { base64: 'abc', mimeType: 'image/jpeg' },
    ];
    const receipt = {
      ...READ_OK,
      total: 105.0,
      category: 'Grocery',
      confidence: 0.95,
      merchant: 'Walmart',
    };

    const paths = await saveImages(images, 'SM123', receipt);

    expect(paths).toEqual(['receipts-permanent/SM123/0.jpg']);
  });

  it('routes to permanent prefix for Health or Home categories', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/png' }];
    
    const pathsHealth = await saveImages(images, 'SM123', { ...READ_OK, total: 10.0, category: 'Health' });
    expect(pathsHealth).toEqual(['receipts-permanent/SM123/0.png']);

    const pathsHome = await saveImages(images, 'SM123', { ...READ_OK, total: 10.0, category: 'Home' });
    expect(pathsHome).toEqual(['receipts-permanent/SM123/0.png']);
  });

  it('routes to permanent prefix for low confidence', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/png' }];
    const paths = await saveImages(images, 'SM123', { ...READ_OK, total: 10.0, category: 'Grocery', confidence: 0.75 });
    expect(paths).toEqual(['receipts-permanent/SM123/0.png']);
  });

  it('routes to permanent prefix for IKEA merchant', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/png' }];
    const paths = await saveImages(images, 'SM123', { ...READ_OK, total: 10.0, category: 'Grocery', merchant: 'IKEA Toronto' });
    expect(paths).toEqual(['receipts-permanent/SM123/0.png']);
  });

  it('stores failed receipt images in the quarantine prefix', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/jpeg' }];

    const paths = await saveFailedImages(images, 'MM123');

    expect(paths).toEqual(['receipts-failed/MM123/0.jpg']);
    expect(admin.__mocks.fileMock).toHaveBeenCalledWith('receipts-failed/MM123/0.jpg');
  });

  it('keeps the photo of a receipt flagged for checking', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/jpeg' }];
    const base = { ...READ_OK, total: 15.8, category: 'Takeout/Dining', confidence: 0.95, merchant: "Wendy's" };

    const wrongYear = await saveImages(images, 'SM1', { ...base, date: '2019-08-26' });
    const badTotals = await saveImages(images, 'SM2', { ...base, items: [{ name: 'Combo', price: 17.18 }], subtotal: 13.98 });

    expect(wrongYear).toEqual(['receipts-permanent/SM1/0.jpg']);
    expect(badTotals).toEqual(['receipts-permanent/SM2/0.jpg']);
  });

  it('keeps the photo of a receipt read with no date or no items', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/png' }];
    const base = { ...READ_OK, total: 37.96, category: 'Takeout/Dining', confidence: 0.95, merchant: 'Hambrgr' };

    const noDate = await saveImages(images, 'MM1', { ...base, date: null });
    const noItems = await saveImages(images, 'MM2', { ...base, items: [] });

    expect(noDate).toEqual(['receipts-permanent/MM1/0.png']);
    expect(noItems).toEqual(['receipts-permanent/MM2/0.png']);
  });
});
