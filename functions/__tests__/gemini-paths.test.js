jest.mock('@google/generative-ai');
jest.mock('firebase-functions/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../lib/config');
const { parseReceiptFromBase64, parseReceiptFromText, parseReceiptFromUrl } = require('../lib/gemini');

// Each step is an object (JSON reply), a raw string (reply text), an Error, or a function.
function setup(...steps) {
  const calls = [];
  const generateContent = jest.fn((parts) => {
    calls.push(parts);
    const step = steps.shift();
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === 'function') return step();
    const text = typeof step === 'string' ? step : JSON.stringify(step);
    return Promise.resolve({ response: { text: () => text } });
  });
  const models = [];
  GoogleGenerativeAI.mockImplementation(() => ({
    getGenerativeModel: jest.fn((opts) => { models.push(opts.model); return { generateContent }; }),
  }));
  return { generateContent, models, calls };
}

const GOOD = {
  merchant: 'IKEA', date: '2026-08-25', total: 20.5, category: 'Home',
  items: [{ name: 'basket', price: 20.5 }], confidence: 0.95,
};
const ONE = [{ base64: 'aaa', mimeType: 'image/jpeg' }];

describe('gemini model routing', () => {
  it('uses the flash model first, then the pro model on escalation', async () => {
    const { models } = setup({ ...GOOD, confidence: 0.4 }, GOOD);
    await parseReceiptFromBase64(ONE, 'key');
    expect(models).toEqual(['gemini-flash-latest', 'gemini-pro-latest']);
  });

  it('forcePro goes straight to the pro model', async () => {
    const { models } = setup(GOOD);
    await parseReceiptFromBase64(ONE, 'key', true);
    expect(models).toEqual(['gemini-pro-latest']);
  });

  it('accepts a result with no confidence field when everything else is present', async () => {
    const { confidence, ...noConfidence } = GOOD;
    const { generateContent } = setup(noConfidence);
    await expect(parseReceiptFromBase64(ONE, 'key')).resolves.toEqual(noConfidence);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('escalates when the total is missing', async () => {
    const { generateContent } = setup({ ...GOOD, total: null }, GOOD);
    await expect(parseReceiptFromBase64(ONE, 'key')).resolves.toEqual(GOOD);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});

describe('malformed JSON handling', () => {
  it('cleans fenced JSON from Flash without escalating', async () => {
    const { generateContent } = setup('```json\n' + JSON.stringify(GOOD) + '\n```');
    await expect(parseReceiptFromBase64(ONE, 'key')).resolves.toEqual(GOOD);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('extracts JSON wrapped in chatter', async () => {
    setup('Sure! Here it is:\n' + JSON.stringify(GOOD) + '\nHope that helps.');
    await expect(parseReceiptFromBase64(ONE, 'key')).resolves.toEqual(GOOD);
  });

  it('falls back to Pro when Flash returns invalid JSON', async () => {
    const { generateContent, models } = setup('{"merchant": "IKEA", ', GOOD);
    await expect(parseReceiptFromBase64(ONE, 'key')).resolves.toEqual(GOOD);
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(models).toEqual(['gemini-flash-latest', 'gemini-pro-latest']);
  });

  it('unrecoverable JSON from both models ends in the OCR path', async () => {
    setup('{oops}', '{still oops}', 'x'.repeat(10));
    await expect(parseReceiptFromBase64(ONE, 'key')).rejects.toThrow('OCR text too short');
  });
});

describe('multi-image and legacy signatures', () => {
  it('sends every image, then the prompt, in one request', async () => {
    const { calls } = setup(GOOD);
    const images = [
      { base64: 'one', mimeType: 'image/jpeg' },
      { base64: 'two', mimeType: 'image/png' },
      { base64: 'three', mimeType: 'image/webp' },
    ];
    await parseReceiptFromBase64(images, 'key');
    const parts = calls[0];
    expect(parts).toHaveLength(4);
    expect(parts.slice(0, 3).map((p) => p.inlineData)).toEqual([
      { data: 'one', mimeType: 'image/jpeg' },
      { data: 'two', mimeType: 'image/png' },
      { data: 'three', mimeType: 'image/webp' },
    ]);
    expect(parts[3].text).toContain('Extract the receipt data');
  });

  it('accepts the legacy (base64String, mimeType) signature', async () => {
    const { calls } = setup(GOOD);
    await parseReceiptFromBase64('legacy64', 'image/png');
    // Legacy call shape treats arg 2 as the mime type, so apiKey is image/png here;
    // the point is that the image is wrapped correctly.
    expect(calls[0][0].inlineData).toEqual({ data: 'legacy64', mimeType: 'image/png' });
  });
});

describe('OCR fallback when both models fail', () => {
  it('transcribes the image with Pro and parses the text', async () => {
    const ocr = 'IKEA\n123 Main St\n2026-08-25\nbasket 20.50\nTOTAL 20.50';
    const { generateContent, calls } = setup(
      new Error('flash down'),       // Flash
      new Error('pro down'),         // Pro
      () => Promise.resolve({ response: { text: () => ocr } }), // OCR transcription
      GOOD,                          // text parse on Flash
    );
    await expect(parseReceiptFromBase64(ONE, 'key')).resolves.toEqual(GOOD);
    expect(generateContent).toHaveBeenCalledTimes(4);
    // OCR request has the image plus the transcription instruction
    expect(calls[2][0].inlineData.data).toBe('aaa');
    expect(calls[2].at(-1).text).toContain('Transcribe the receipt text');
    // Final parse is text-only and includes the OCR text
    expect(calls[3].at(-1).text).toContain('Receipt Text:');
    expect(calls[3].at(-1).text).toContain('TOTAL 20.50');
  });

  it('gives up with a clear error when the OCR text is too short', async () => {
    setup(new Error('flash down'), new Error('pro down'), () => Promise.resolve({ response: { text: () => 'blurry' } }));
    await expect(parseReceiptFromBase64(ONE, 'key')).rejects.toMatchObject({ message: 'OCR text too short for reliable parsing' });
  });

  it('gives up when the OCR transcription is empty', async () => {
    setup(new Error('a'), new Error('b'), () => Promise.resolve({ response: { text: () => '' } }));
    await expect(parseReceiptFromBase64(ONE, 'key')).rejects.toThrow('OCR text too short');
  });
});

describe('timeouts', () => {
  afterEach(() => jest.useRealTimers());

  it('treats a hung Flash call as a failure and escalates to Pro', async () => {
    jest.useFakeTimers();
    const { generateContent } = setup(() => new Promise(() => {}), GOOD);
    const pending = parseReceiptFromBase64(ONE, 'key');
    await jest.advanceTimersByTimeAsync(config.GEMINI_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual(GOOD);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('clears the timer after a successful call (no leaked timers)', async () => {
    jest.useFakeTimers();
    setup(GOOD);
    await parseReceiptFromBase64(ONE, 'key');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('parseReceiptFromText', () => {
  it('sends the prompt plus the receipt text and returns the Flash result', async () => {
    const { calls, models } = setup(GOOD);
    await expect(parseReceiptFromText('Costco total 5.00', 'key')).resolves.toEqual(GOOD);
    expect(models).toEqual(['gemini-flash-latest']);
    expect(calls[0][1].text).toBe('Receipt Text:\nCostco total 5.00');
  });

  it('escalates on low confidence', async () => {
    const { models } = setup({ ...GOOD, confidence: 0.3 }, GOOD);
    await expect(parseReceiptFromText('x', 'key')).resolves.toEqual(GOOD);
    expect(models).toEqual(['gemini-flash-latest', 'gemini-pro-latest']);
  });

  it('does not require items or a date from Flash (pasted text may lack them)', async () => {
    const sparse = { merchant: 'Netflix', total: 12, date: null, items: [], confidence: 0.9 };
    const { generateContent } = setup(sparse);
    await expect(parseReceiptFromText('Netflix 12', 'key')).resolves.toEqual(sparse);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('falls back to Pro when Flash throws or returns bad JSON, and surfaces a Pro failure', async () => {
    const first = setup(new Error('down'), GOOD);
    await expect(parseReceiptFromText('x', 'key')).resolves.toEqual(GOOD);
    expect(first.models).toEqual(['gemini-flash-latest', 'gemini-pro-latest']);
    setup('garbage', GOOD);
    await expect(parseReceiptFromText('x', 'key')).resolves.toEqual(GOOD);
    setup(new Error('flash'), new Error('pro down'));
    await expect(parseReceiptFromText('x', 'key')).rejects.toThrow('pro down');
  });

  it('forcePro skips Flash', async () => {
    const { models } = setup(GOOD);
    await parseReceiptFromText('x', 'key', true);
    expect(models).toEqual(['gemini-pro-latest']);
  });
});

describe('parseReceiptFromUrl', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('downloads the image and parses it', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('hello').buffer.slice(0, 5),
      headers: { get: () => 'image/png' },
    });
    const { calls } = setup(GOOD);
    await expect(parseReceiptFromUrl('https://example.test/r.png', 'key')).resolves.toEqual(GOOD);
    expect(global.fetch).toHaveBeenCalledWith('https://example.test/r.png');
    expect(calls[0][0].inlineData.data).toBeTruthy();
  });

  it('throws on a failed download', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(parseReceiptFromUrl('https://example.test/missing.png', 'key')).rejects.toThrow('Failed to fetch image: 404');
  });
});
