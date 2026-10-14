const { VALID_CATEGORIES, VALID_TYPES, isRealDate } = require('./validate');

const SCHEMA_VERSION = 1;
const MAX_AMOUNT = 100000;
const MAX_ITEMS = 200;

const ITEM_PROPERTIES = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  price: { type: 'number' },
  quantity: { type: 'integer', minimum: 1, maximum: 1000 },
  category: { type: 'string', enum: VALID_CATEGORIES },
  unitPrice: { type: 'number' },
  lineTotal: { type: 'number' },
};

const TOP_PROPERTIES = {
  schemaVersion: { type: 'integer', const: SCHEMA_VERSION },
  idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
  merchant: { type: 'string', minLength: 1, maxLength: 120 },
  total: { type: 'number', description: 'Receipt total. Refunds may be given as positive or negative.' },
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Purchase date, YYYY-MM-DD.' },
  subtotal: { type: 'number' },
  tax: { type: 'number' },
  currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'CAD' },
  type: { type: 'string', enum: VALID_TYPES, default: 'purchase' },
  category: { type: 'string', enum: VALID_CATEGORIES },
  subCategory: { type: 'string', maxLength: 80 },
  location: { type: 'string', maxLength: 200 },
  isSubscription: { type: 'boolean' },
  items: {
    type: 'array',
    maxItems: MAX_ITEMS,
    items: { type: 'object', required: ['name', 'price'], additionalProperties: false, properties: ITEM_PROPERTIES },
  },
  source: {
    type: 'object',
    required: ['client'],
    additionalProperties: false,
    properties: {
      client: { type: 'string', minLength: 1, maxLength: 50, description: 'Assistant name, e.g. claude, chatgpt, codex.' },
      model: { type: 'string', maxLength: 80 },
    },
  },
};

const INPUT_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'idempotencyKey', 'merchant', 'total', 'date', 'source'],
  additionalProperties: false,
  properties: TOP_PROPERTIES,
};

function amountError(value, path, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} must be a number`);
  } else if (Math.abs(value) > MAX_AMOUNT) {
    errors.push(`${path} must be between -${MAX_AMOUNT} and ${MAX_AMOUNT}`);
  } else if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    errors.push(`${path} must have at most 2 decimal places`);
  }
}

function checkString(value, path, errors, { min = 0, max }) {
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`);
    return;
  }
  const len = value.trim().length;
  if (len < min || value.length > max) errors.push(`${path} must be ${min ? `${min}-` : 'up to '}${max} characters`);
}

// Strict validation of a create_receipt payload. Unlike the SMS path, bad
// values are rejected (never coerced) so the calling assistant can retry.
function validateImport(args, now = new Date()) {
  const errors = [];
  const warnings = [];

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { errors: ['arguments must be an object'], warnings };
  }

  for (const key of Object.keys(args)) {
    if (!(key in TOP_PROPERTIES)) errors.push(`unknown field "${key}"`);
  }
  for (const key of INPUT_SCHEMA.required) {
    if (args[key] === undefined) errors.push(`${key} is required`);
  }

  if (args.schemaVersion !== undefined && args.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (args.idempotencyKey !== undefined) checkString(args.idempotencyKey, 'idempotencyKey', errors, { min: 8, max: 128 });
  if (args.merchant !== undefined) checkString(args.merchant, 'merchant', errors, { min: 1, max: 120 });
  if (args.total !== undefined) amountError(args.total, 'total', errors);
  if (args.subtotal !== undefined) amountError(args.subtotal, 'subtotal', errors);
  if (args.tax !== undefined) amountError(args.tax, 'tax', errors);

  if (args.date !== undefined) {
    if (!isRealDate(args.date)) {
      errors.push('date must be a real calendar date in YYYY-MM-DD format');
    } else if (new Date(`${args.date}T00:00:00Z`).getTime() > now.getTime() + 36 * 60 * 60 * 1000) {
      errors.push('date cannot be in the future');
    }
  }
  if (args.currency !== undefined && !(typeof args.currency === 'string' && /^[A-Z]{3}$/.test(args.currency))) {
    errors.push('currency must be a 3-letter uppercase ISO code');
  }
  if (args.type !== undefined && !VALID_TYPES.includes(args.type)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if (args.category !== undefined && !VALID_CATEGORIES.includes(args.category)) {
    errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }
  if (args.subCategory !== undefined) checkString(args.subCategory, 'subCategory', errors, { max: 80 });
  if (args.location !== undefined) checkString(args.location, 'location', errors, { max: 200 });
  if (args.isSubscription !== undefined && typeof args.isSubscription !== 'boolean') {
    errors.push('isSubscription must be a boolean');
  }

  if (args.items !== undefined) {
    if (!Array.isArray(args.items)) {
      errors.push('items must be an array');
    } else if (args.items.length > MAX_ITEMS) {
      errors.push(`items can have at most ${MAX_ITEMS} entries`);
    } else {
      args.items.forEach((item, i) => {
        const path = `items[${i}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`${path} must be an object`);
          return;
        }
        for (const key of Object.keys(item)) {
          if (!(key in ITEM_PROPERTIES)) errors.push(`${path}: unknown field "${key}"`);
        }
        if (item.name === undefined) errors.push(`${path}.name is required`);
        else checkString(item.name, `${path}.name`, errors, { min: 1, max: 200 });
        if (item.price === undefined) errors.push(`${path}.price is required`);
        else amountError(item.price, `${path}.price`, errors);
        if (item.unitPrice !== undefined) amountError(item.unitPrice, `${path}.unitPrice`, errors);
        if (item.lineTotal !== undefined) amountError(item.lineTotal, `${path}.lineTotal`, errors);
        if (item.quantity !== undefined && !(Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 1000)) {
          errors.push(`${path}.quantity must be an integer from 1 to 1000`);
        }
        if (item.category !== undefined && !VALID_CATEGORIES.includes(item.category)) {
          errors.push(`${path}.category must be one of: ${VALID_CATEGORIES.join(', ')}`);
        }
      });
    }
  }

  if (args.source !== undefined) {
    const src = args.source;
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      errors.push('source must be an object');
    } else {
      for (const key of Object.keys(src)) {
        if (key !== 'client' && key !== 'model') errors.push(`source: unknown field "${key}"`);
      }
      if (src.client === undefined) errors.push('source.client is required');
      else checkString(src.client, 'source.client', errors, { min: 1, max: 50 });
      if (src.model !== undefined) checkString(src.model, 'source.model', errors, { max: 80 });
    }
  }

  if (errors.length) return { errors, warnings };

  // Non-fatal consistency checks, stored with the receipt and returned to the caller.
  const near = (a, b) => Math.abs(a - b) <= 0.05;
  if (args.subtotal !== undefined && args.tax !== undefined
      && !near(Math.abs(args.subtotal) + Math.abs(args.tax), Math.abs(args.total))) {
    warnings.push('subtotal + tax does not match total');
  }
  if (args.items?.length && args.subtotal !== undefined) {
    const sum = args.items.reduce((acc, it) => acc + Math.abs(it.lineTotal ?? it.price), 0);
    if (!near(sum, Math.abs(args.subtotal))) warnings.push('item prices do not add up to subtotal');
  }
  if (!args.items?.length) warnings.push('no line items provided');

  return { errors, warnings };
}

module.exports = { SCHEMA_VERSION, INPUT_SCHEMA, validateImport, isRealDate };
