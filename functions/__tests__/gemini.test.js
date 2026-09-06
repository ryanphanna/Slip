jest.mock('@google/generative-ai');
jest.mock('firebase-functions/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parseReceiptFromBase64, cleanJsonResponse } = require('../lib/gemini');

function mockModelSequence(...responses) {
  const generateContent = jest.fn();
  responses.forEach(r => {
    if (r instanceof Error) {
      generateContent.mockImplementationOnce(() => Promise.reject(r));
    } else {
      generateContent.mockImplementationOnce(() => Promise.resolve({ response: { text: () => JSON.stringify(r) } }));
    }
  });
  GoogleGenerativeAI.mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({ generateContent })),
  }));
  return generateContent;
}

const IMAGES = [{ base64: 'abc', mimeType: 'image/jpeg' }];
const GOOD_RECEIPT = {
  merchant: 'IKEA', date: '2026-08-25', total: 20.5, subtotal: 19, tax: 1.5,
  category: 'Home', items: [{ name: 'RÄNEN basket', price: 9.98, quantity: 1, category: 'Home' }],
  currency: 'CAD', type: 'purchase', isSubscription: false, confidence: 0.95,
};

describe('parseReceiptFromBase64 model escalation', () => {
  it('accepts a high-confidence, complete Flash result without calling Pro', async () => {
    const generateContent = mockModelSequence(GOOD_RECEIPT);
    const result = await parseReceiptFromBase64(IMAGES, 'key');
    expect(result).toEqual(GOOD_RECEIPT);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('escalates to Pro when Flash confidence is below 0.8', async () => {
    const lowConfidence = { ...GOOD_RECEIPT, confidence: 0.5 };
    const generateContent = mockModelSequence(lowConfidence, GOOD_RECEIPT);
    const result = await parseReceiptFromBase64(IMAGES, 'key');
    expect(result).toEqual(GOOD_RECEIPT);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('escalates to Pro when Flash omits the date despite high confidence', async () => {
    const missingDate = { ...GOOD_RECEIPT, date: null };
    const generateContent = mockModelSequence(missingDate, GOOD_RECEIPT);
    const result = await parseReceiptFromBase64(IMAGES, 'key');
    expect(result).toEqual(GOOD_RECEIPT);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('escalates to Pro when Flash returns no items despite high confidence', async () => {
    const noItems = { ...GOOD_RECEIPT, items: [] };
    const generateContent = mockModelSequence(noItems, GOOD_RECEIPT);
    const result = await parseReceiptFromBase64(IMAGES, 'key');
    expect(result).toEqual(GOOD_RECEIPT);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('escalates to Pro when Flash throws', async () => {
    const generateContent = mockModelSequence(new Error('Flash unavailable'), GOOD_RECEIPT);
    const result = await parseReceiptFromBase64(IMAGES, 'key');
    expect(result).toEqual(GOOD_RECEIPT);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('forces Pro directly when forcePro is set, skipping Flash', async () => {
    const generateContent = mockModelSequence(GOOD_RECEIPT);
    const result = await parseReceiptFromBase64(IMAGES, 'key', true);
    expect(result).toEqual(GOOD_RECEIPT);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe('cleanJsonResponse', () => {
  it('parses plain JSON', () => {
    expect(cleanJsonResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown code fences', () => {
    expect(cleanJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts a JSON object surrounded by extra text', () => {
    expect(cleanJsonResponse('Here you go:\n{"a":1}\nEnjoy!')).toEqual({ a: 1 });
  });

  it('throws on unparseable text', () => {
    expect(() => cleanJsonResponse('not json at all')).toThrow('Gemini returned invalid JSON');
  });
});
