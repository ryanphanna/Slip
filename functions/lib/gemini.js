const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');
const logger = require('firebase-functions/logger');

const FLASH_MODEL = 'gemini-flash-latest';
const PRO_MODEL = 'gemini-pro-latest';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Gemini call timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// Authoritative prompt used by production and all test scripts.
// Includes confidence scoring for quality fallback logic.
const PROMPT = `Extract the receipt data and return ONLY valid JSON — no markdown, no explanation:
{
  "merchant": "store/brand name as printed in the header or logo",
  "location": "store address, or a named pickup/delivery location if the receipt has one, as printed on receipt, or null",
  "date": "YYYY-MM-DD or null",
  "total": number or null,
  "subtotal": number or null,
  "tax": number or null,
  "category": "one of: Takeout/Dining, Grocery, Transport, Shopping, Entertainment, Health, Home, Other",
  "subCategory": "Provide a specific sub-category based on the merchant (e.g. Coffee Shop, Fast Food, Supermarket, Electronics, Pharmacy, Rideshare, Clothing, Alcohol)",
  "items": [{ "name": "item name", "price": number, "quantity": "unit count for this line, default 1", "category": "one of: Takeout/Dining, Grocery, Transport, Shopping, Entertainment, Health, Home, Other" }],
  "currency": "Currency code (e.g. CAD, USD, EUR). Infer from location if implied.",
  "type": "purchase or refund",
  "isSubscription": boolean,
  "loyaltyPointsEarned": number or null,
  "loyaltyPointsBalance": number or null,
  "confidence": 0.0 to 1.0 (how certain you are about the extraction)
}
Merchant vs location: "merchant" is the store/brand name only — read it from a logo or header. If the receipt separately names a pickup counter, delivery spot, or branch nickname distinct from the brand (e.g. an app order confirmation with a "Pick up location" field), that name goes in "location", never in "merchant". Never invent or guess a plausible-sounding merchant name if the brand isn't clearly legible on the receipt — extract your best literal reading instead, and lower "confidence" accordingly.
Date: Every receipt has a date printed somewhere — check the top, bottom, header, and footer of the receipt. It may appear as a timestamp, a short date like "Jun 22 2026", or embedded in a receipt number. Always extract it; only use null if the receipt is genuinely cut off and no date is visible anywhere. Abbreviated numeric dates (e.g. "07/27/26" or "26/07/25") do not follow one fixed token order — different POS systems use MM/DD/YY, DD/MM/YY, or YY/MM/DD. Do not default to a single assumed order. Instead: if the same receipt also prints an unambiguous 4-digit-year date anywhere (e.g. "2026-07-25"), that is authoritative — use it and read its digits carefully. If only an abbreviated date is present, infer the token order from context (a token over 31 can only be a year; a token that would place the date after the receipt's own timestamp is wrong). Do not transpose or misread adjacent digits.
Items: Include every line item on the receipt. Do not skip items or summarize groups. If the receipt has 20 items, return all 20. For each item, assign a "category" matching one of the eight valid options (Takeout/Dining, Grocery, Transport, Shopping, Entertainment, Health, Home, Other). At mixed stores like Walmart or Costco, assign per-item: "Grocery" for food, "Shopping" for apparel/electronics, "Health" for pharmacy/vitamins, "Home" for housewares. If a line shows a quantity greater than 1 (e.g. "2 * $4.99"), keep it as a single item entry with the combined line price, but set "quantity" to the unit count rather than defaulting to 1.
Zero totals: If items were redeemed via loyalty points or rewards and cost $0, set total to 0 and still capture all items and the receipt date.
Subscriptions: Set "isSubscription" to true for recurring charges (streaming, SaaS, phone/internet, gym), false otherwise.
Refunds: If the receipt represents money being returned, set "type" to "refund". Report "total", "subtotal", "tax", and every item "price" as their magnitudes (however they're printed) — the sign is normalized separately, not something you need to get right.
Discounts: Record the final net price paid for each item after any inline per-item discount. Do not add a separate line item for a bottom-of-receipt discount summary — if per-item prices already reflect the discount, the summary line is redundant.`;

/**
 * Strip markdown code fences and parse JSON. Attempts a fallback extraction
 * if the model returns extra text around the JSON payload.
 */
function cleanJsonResponse(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      const sliced = cleaned.slice(first, last + 1);
      try {
        return JSON.parse(sliced);
      } catch (innerErr) {
        const wrapped = new Error('Gemini returned invalid JSON');
        wrapped.cause = innerErr;
        throw wrapped;
      }
    }
    const wrapped = new Error('Gemini returned invalid JSON');
    wrapped.cause = err;
    throw wrapped;
  }
}

function buildImagePromptParts(images) {
  return images.map(img => ({
    inlineData: { data: img.base64, mimeType: img.mimeType }
  }));
}

async function parseWithPro(promptParts, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: PRO_MODEL,
    generationConfig: { responseMimeType: 'application/json' }
  });

  const result = await withTimeout(model.generateContent(promptParts), config.GEMINI_TIMEOUT_MS);
  return cleanJsonResponse(result.response.text());
}

async function extractReceiptTextFromBase64(images, apiKey) {
  // Backwards compatibility for single string signature
  if (typeof images === 'string') {
    images = [{ base64: arguments[0], mimeType: arguments[1] || 'image/jpeg' }];
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: PRO_MODEL });

  const promptParts = buildImagePromptParts(images);
  promptParts.push({
    text: 'Transcribe the receipt text exactly as seen. Return plain text only with line breaks. Ignore any phone UI or background.'
  });

  const result = await withTimeout(model.generateContent(promptParts), config.GEMINI_TIMEOUT_MS);
  return (result.response.text() || '').trim();
}

/**
 * Parse one or more receipt images using Gemini.
 * @param {Array<{base64: string, mimeType: string}> | string} images - Array of images or legacy single base64 string
 * @param {string} apiKey - Gemini API key
 * @param {boolean} forcePro - Whether to skip Flash and go directly to Pro
 */
async function parseReceiptFromBase64(images, apiKey, forcePro = false) {
  // Backwards compatibility for single string signature (used by some scripts)
  if (typeof images === 'string') {
    images = [{ base64: arguments[0], mimeType: arguments[1] || 'image/jpeg' }];
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const promptParts = buildImagePromptParts(images);
  promptParts.push({ text: PROMPT });

  if (forcePro) {
    logger.info('Bypassing Flash model: prioritizing first-time user parsing on Pro');
    return await parseWithPro(promptParts, apiKey);
  }

  // Try Flash first
  try {
    const model = genAI.getGenerativeModel({
      model: FLASH_MODEL,
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await withTimeout(model.generateContent(promptParts), config.GEMINI_TIMEOUT_MS);
    const parsed = cleanJsonResponse(result.response.text());

    if (parsed.confidence != null && parsed.confidence < 0.8) {
      return await parseWithPro(promptParts, apiKey);
    }

    // Image receipts always have a date, a total, and at least one item —
    // any of those missing from Flash means a missed extraction
    const itemsMissing = !Array.isArray(parsed.items) || parsed.items.length === 0;
    if (parsed.date == null || parsed.total == null || itemsMissing) {
      return await parseWithPro(promptParts, apiKey);
    }

    return parsed;
  } catch (err) {
    // Any failure on Flash → Pro fallback
    try {
      return await parseWithPro(promptParts, apiKey);
    } catch (proErr) {
      const ocrText = await extractReceiptTextFromBase64(images, apiKey);
      if (!ocrText || ocrText.length < 40) {
        const wrapped = new Error('OCR text too short for reliable parsing');
        wrapped.cause = proErr;
        throw wrapped;
      }
      return await parseReceiptFromText(ocrText, apiKey);
    }
  }
}

/**
 * Parse receipt from raw pasted text.
 */
async function parseReceiptFromText(text, apiKey, forcePro = false) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const promptParts = [
    { text: PROMPT },
    { text: `Receipt Text:\n${text}` }
  ];

  if (forcePro) {
    logger.info('Bypassing Flash model: prioritizing first-time user parsing on Pro');
    return await parseWithPro(promptParts, apiKey);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: FLASH_MODEL,
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await withTimeout(model.generateContent(promptParts), config.GEMINI_TIMEOUT_MS);
    const parsed = cleanJsonResponse(result.response.text());

    if (parsed.confidence != null && parsed.confidence < 0.8) {
      return await parseWithPro(promptParts, apiKey);
    }

    return parsed;
  } catch (err) {
    return await parseWithPro(promptParts, apiKey);
  }
}

/**
 * Fetch an image URL and parse it (primarily for local scripts).
 */
async function parseReceiptFromUrl(imageUrl, apiKey) {
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) {
    throw new Error(`Failed to fetch image: ${imgResponse.status}`);
  }
  const buffer = await imgResponse.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mimeType = imgResponse.headers.get('content-type') || 'image/jpeg';
  return parseReceiptFromBase64(base64, apiKey);  // note: single arg form handled inside
}

module.exports = {
  PROMPT,
  parseReceiptFromBase64,
  parseReceiptFromText,
  parseReceiptFromUrl,
  cleanJsonResponse,   // exported for advanced script use if needed
};
