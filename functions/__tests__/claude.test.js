jest.mock('firebase-functions/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@google/generative-ai');
jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const Anthropic = jest.fn(() => ({ messages: { create } }));
  Anthropic.__create = create;
  class APIError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  Anthropic.APIError = APIError;
  Anthropic.AuthenticationError = class extends APIError {};
  Anthropic.RateLimitError = class extends APIError {};
  Anthropic.APIConnectionError = class extends APIError {};
  return Anthropic;
});

const Anthropic = require('@anthropic-ai/sdk');
const { PROMPT } = require('../lib/gemini');
const {
  parseReceiptWithClaude, buildReceiptRequest, RECEIPT_SCHEMA, DEFAULT_MODEL, MAX_TOKENS,
} = require('../lib/claude');

const create = Anthropic.__create;

const IMAGES = [
  { base64: 'aaa', mimeType: 'image/jpeg' },
  { base64: 'bbb', mimeType: 'image/png' },
];
const GOOD_RECEIPT = {
  merchant: 'IKEA', location: null, date: '2026-08-25', total: 20.5, subtotal: 19, tax: 1.5,
  category: 'Home', subCategory: 'Furniture',
  items: [{ name: 'RÄNEN basket', price: 9.98, quantity: 1, category: 'Home' }],
  currency: 'CAD', type: 'purchase', isSubscription: false,
  loyaltyPointsEarned: null, loyaltyPointsBalance: null, confidence: 0.95,
};

function respondWith(overrides = {}) {
  create.mockResolvedValueOnce({
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(GOOD_RECEIPT) }],
    usage: { input_tokens: 3200, output_tokens: 410 },
    ...overrides,
  });
}

beforeEach(() => {
  create.mockReset();
  Anthropic.mockClear();
  delete process.env.CLAUDE_MODEL;
  delete process.env.CLAUDE_EFFORT;
});

describe('Claude receipt request shape', () => {
  it('uses claude-opus-5-5, low effort and a JSON schema by default', async () => {
    respondWith();
    await parseReceiptWithClaude(IMAGES, { today: '2026-11-09' });

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0][0];
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.max_tokens).toBe(MAX_TOKENS);
    expect(request.output_config.effort).toBe('low');
    expect(request.output_config.format).toEqual({ type: 'json_schema', schema: RECEIPT_SCHEMA });
  });

  it('sends nothing the model rejects and no fallback model', () => {
    const request = buildReceiptRequest(IMAGES);
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools', 'fallbacks', 'betas']) {
      expect(request).not.toHaveProperty(banned);
    }
    // No assistant prefill: the only message is the user's.
    expect(request.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('puts every image before the text, as base64 blocks', () => {
    const { content } = buildReceiptRequest(IMAGES, { today: '2026-11-09' }).messages[0];
    expect(content.map((block) => block.type)).toEqual(['image', 'image', 'text', 'text']);
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aaa' } });
    expect(content[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'bbb' });
  });

  it('uses the same prompt wording and date hint as the Gemini parser', () => {
    const { content } = buildReceiptRequest(IMAGES, { today: '2026-11-09' }).messages[0];
    expect(content[2].text).toBe(PROMPT);
    expect(content[3].text).toContain("Today's date is 2026-11-09.");
  });

  it('lets the model and effort be overridden by option or env var', () => {
    expect(buildReceiptRequest(IMAGES, { model: 'claude-sonnet-5-5', effort: 'high' })).toMatchObject({
      model: 'claude-sonnet-5-5', output_config: { effort: 'high' },
    });
    process.env.CLAUDE_MODEL = 'claude-haiku-5-5';
    process.env.CLAUDE_EFFORT = 'medium';
    expect(buildReceiptRequest(IMAGES)).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'medium' } });
    expect(() => buildReceiptRequest(IMAGES, { effort: 'extreme' })).toThrow(/Unknown Claude effort/);
  });

  it('creates the client without a hardcoded key', async () => {
    respondWith();
    await parseReceiptWithClaude(IMAGES);
    const options = Anthropic.mock.calls[0][0] || {};
    expect(options).not.toHaveProperty('apiKey');
    expect(options).not.toHaveProperty('authToken');
  });

  it('has a schema the API accepts: every object closed, every field required', () => {
    const check = (schema) => {
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
        Object.values(schema.properties).forEach(check);
      }
      if (schema.type === 'array') check(schema.items);
    };
    check(RECEIPT_SCHEMA);
    expect(Object.keys(RECEIPT_SCHEMA.properties).sort()).toEqual(Object.keys(GOOD_RECEIPT).sort());
  });
});

describe('Claude receipt results', () => {
  it('returns the parsed receipt with usage, time and one call', async () => {
    respondWith();
    const result = await parseReceiptWithClaude(IMAGES);
    expect(result).toMatchObject({
      ok: true, receipt: GOOD_RECEIPT, error: null, stopReason: 'end_turn', model: 'claude-opus-5-5',
      usage: { inputTokens: 3200, outputTokens: 410 }, calls: 1,
    });
    expect(typeof result.ms).toBe('number');
  });

  it('records a refusal as a failure instead of throwing', async () => {
    respondWith({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [] });
    const result = await parseReceiptWithClaude(IMAGES);
    expect(result.ok).toBe(false);
    expect(result.receipt).toBeNull();
    expect(result.stopReason).toBe('refusal');
    expect(result.error).toMatch(/declined.*cyber/);
    expect(result.usage).toEqual({ inputTokens: 3200, outputTokens: 410 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('records a cut-off answer (max_tokens) as a failure and does not parse the partial JSON', async () => {
    respondWith({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"merchant": "IK' }] });
    const result = await parseReceiptWithClaude(IMAGES);
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('max_tokens');
    expect(result.error).toMatch(/cut off/);
    expect(result.calls).toBe(1);
  });

  it('records an API error as a failure and makes no second call', async () => {
    create.mockRejectedValueOnce(new Anthropic.RateLimitError(429, 'slow down'));
    const result = await parseReceiptWithClaude(IMAGES);
    expect(result).toMatchObject({ ok: false, calls: 1, error: 'Claude rate limit hit: slow down' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('refuses unsupported image types without calling the API', async () => {
    const result = await parseReceiptWithClaude([{ base64: 'x', mimeType: 'image/heic' }]);
    expect(result).toMatchObject({ ok: false, calls: 0, error: 'Claude does not accept image/heic images' });
    expect(create).not.toHaveBeenCalled();
  });
});
