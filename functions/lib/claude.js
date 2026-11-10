// Claude receipt parser, for provider comparison only (scripts/compare-providers.js).
// Not wired into any production path: nothing in index.js or the SMS/web flows
// requires this file.
//
// It sends the same prompt text and date hint as the Gemini parser so the
// comparison is fair, and asks for the answer against a real JSON schema, so
// there is no JSON-repair step. It makes exactly one call per receipt, with no
// fallback model, so the answer is always from the model that was asked.

const Anthropic = require('@anthropic-ai/sdk');
const { PROMPT, datePromptPart } = require('./gemini');

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'low';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 120000;

// Image types the Claude API accepts. Anything else (e.g. HEIC) is recorded as
// a failure for that receipt instead of being converted behind the scenes.
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const CATEGORIES = ['Takeout/Dining', 'Grocery', 'Transport', 'Shopping', 'Entertainment', 'Health', 'Home', 'Other'];

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

// Mirrors the JSON shape described in PROMPT, field for field.
const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchant: nullable('string'),
    location: nullable('string'),
    date: nullable('string'),
    total: nullable('number'),
    subtotal: nullable('number'),
    tax: nullable('number'),
    category: { type: 'string', enum: CATEGORIES },
    subCategory: nullable('string'),
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          price: nullable('number'),
          quantity: { type: 'integer' },
          category: { type: 'string', enum: CATEGORIES },
        },
        required: ['name', 'price', 'quantity', 'category'],
      },
    },
    currency: nullable('string'),
    type: { type: 'string', enum: ['purchase', 'refund'] },
    isSubscription: { type: 'boolean' },
    loyaltyPointsEarned: nullable('number'),
    loyaltyPointsBalance: nullable('number'),
    confidence: { type: 'number' },
  },
  required: [
    'merchant', 'location', 'date', 'total', 'subtotal', 'tax', 'category', 'subCategory', 'items',
    'currency', 'type', 'isSubscription', 'loyaltyPointsEarned', 'loyaltyPointsBalance', 'confidence',
  ],
};

function resolveModel(model) {
  return model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

function resolveEffort(effort) {
  const value = effort || process.env.CLAUDE_EFFORT || DEFAULT_EFFORT;
  if (!EFFORT_LEVELS.includes(value)) {
    throw new Error(`Unknown Claude effort "${value}" (use one of: ${EFFORT_LEVELS.join(', ')})`);
  }
  return value;
}

/**
 * Build the request body. Images go first, then the shared prompt, then the
 * shared date hint, the same order the Gemini parser uses.
 */
function buildReceiptRequest(images, { model, effort, today } = {}) {
  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
  }));
  content.push({ type: 'text', text: PROMPT });
  content.push({ type: 'text', text: datePromptPart(today).text });

  return {
    model: resolveModel(model),
    max_tokens: MAX_TOKENS,
    output_config: {
      effort: resolveEffort(effort),
      format: { type: 'json_schema', schema: RECEIPT_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  };
}

function usageOf(response) {
  const usage = (response && response.usage) || {};
  return {
    // Cached input is billed separately, so add it back for a full input count.
    inputTokens: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
    outputTokens: usage.output_tokens || 0,
  };
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return `Claude API key was rejected: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return `Claude rate limit hit: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Claude API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`.replace('  ', ' ');
  return err.message || String(err);
}

/**
 * Parse one receipt (one or more images) with Claude. One API call, no fallbacks.
 *
 * Never throws for a per-receipt problem. Always resolves to:
 *   { ok, receipt, error, stopReason, model, usage: { inputTokens, outputTokens }, ms, calls }
 * A refusal or a cut-off answer (max_tokens) comes back as ok: false with the reason.
 *
 * @param {Array<{base64: string, mimeType: string}>} images
 * @param {{ model?: string, effort?: string, today?: string, client?: object }} [options]
 */
async function parseReceiptWithClaude(images, options = {}) {
  const model = resolveModel(options.model);
  const failure = (error, extra = {}) => ({
    ok: false, receipt: null, error, stopReason: null, model,
    usage: { inputTokens: 0, outputTokens: 0 }, ms: 0, calls: 0, ...extra,
  });

  if (!Array.isArray(images) || images.length === 0) return failure('No images to parse');
  const unsupported = images.find((img) => !SUPPORTED_IMAGE_TYPES.includes(img.mimeType));
  if (unsupported) return failure(`Claude does not accept ${unsupported.mimeType} images`);

  const request = buildReceiptRequest(images, options);
  // No key is passed: the SDK reads ANTHROPIC_API_KEY from the environment.
  const client = options.client || new Anthropic({ timeout: TIMEOUT_MS });

  const started = Date.now();
  let response;
  try {
    response = await client.messages.create(request);
  } catch (err) {
    return failure(describeError(err), { ms: Date.now() - started, calls: 1 });
  }
  const ms = Date.now() - started;
  const base = { stopReason: response.stop_reason, model: response.model || model, usage: usageOf(response), ms, calls: 1 };

  if (response.stop_reason === 'refusal') {
    const details = response.stop_details;
    const why = details && (details.category || details.explanation)
      ? ` (${[details.category, details.explanation].filter(Boolean).join(': ')})`
      : '';
    return { ...failure(`Claude declined to read this receipt${why}`), ...base };
  }
  if (response.stop_reason === 'max_tokens') {
    return { ...failure(`Claude's answer was cut off at ${request.max_tokens} tokens`), ...base };
  }
  if (response.stop_reason !== 'end_turn') {
    return { ...failure(`Claude stopped unexpectedly (${response.stop_reason})`), ...base };
  }

  const textBlock = (response.content || []).find((block) => block.type === 'text');
  if (!textBlock) return { ...failure('Claude returned no text'), ...base };

  try {
    return { ok: true, receipt: JSON.parse(textBlock.text), error: null, ...base };
  } catch (err) {
    return { ...failure('Claude returned text that was not valid JSON'), ...base };
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  MAX_TOKENS,
  RECEIPT_SCHEMA,
  SUPPORTED_IMAGE_TYPES,
  buildReceiptRequest,
  parseReceiptWithClaude,
};
