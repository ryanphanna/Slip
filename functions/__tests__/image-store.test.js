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
const { saveImages } = require('../lib/image-store');

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
    
    const pathsHealth = await saveImages(images, 'SM123', { total: 10.0, category: 'Health' });
    expect(pathsHealth).toEqual(['receipts-permanent/SM123/0.png']);

    const pathsHome = await saveImages(images, 'SM123', { total: 10.0, category: 'Home' });
    expect(pathsHome).toEqual(['receipts-permanent/SM123/0.png']);
  });

  it('routes to permanent prefix for low confidence', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/png' }];
    const paths = await saveImages(images, 'SM123', { total: 10.0, category: 'Grocery', confidence: 0.75 });
    expect(paths).toEqual(['receipts-permanent/SM123/0.png']);
  });

  it('routes to permanent prefix for IKEA merchant', async () => {
    const images = [{ base64: 'abc', mimeType: 'image/png' }];
    const paths = await saveImages(images, 'SM123', { total: 10.0, category: 'Grocery', merchant: 'IKEA Toronto' });
    expect(paths).toEqual(['receipts-permanent/SM123/0.png']);
  });
});
