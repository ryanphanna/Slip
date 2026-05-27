const { GoogleGenerativeAI } = require('@google/generative-ai');

// Authoritative prompt used by production and all test scripts.
// Includes confidence scoring for quality fallback logic.
const PROMPT = `Extract the receipt data and return ONLY valid JSON — no markdown, no explanation:
{
  "merchant": "store name",
  "location": "store address or location as printed on receipt, or null",
  "date": "YYYY-MM-DD or null",
  "total": number or null,
  "subtotal": number or null,
  "tax": number or null,
  "category": "one of: Takeout/Dining, Grocery, Transport, Shopping, Entertainment, Health, Home, Other",
  "subCategory": "Provide a specific sub-category based on the merchant (e.g. Coffee Shop, Fast Food, Supermarket, Electronics, Pharmacy, Rideshare, Clothing, Alcohol)",
  "items": [{ "name": "item name", "price": number }],
  "currency": "Currency code (e.g. CAD, USD, EUR). Infer from location if implied.",
  "type": "purchase or refund",
  "loyaltyPointsEarned": number or null,
  "loyaltyPointsBalance": number or null,
  "confidence": 0.0 to 1.0 (how certain you are about the extraction)
}
Use null for anything you can't determine. Items can be an empty array.
For each item, record the final net price paid after any inline per-item discount shown beneath it on the receipt. Do not add a separate line item for any discount summary or coupon total that appears at the bottom — if per-item discounts are already reflected in individual prices, the summary line is redundant and should be omitted.`;

/**
 * Strip markdown code fences and parse JSON.
 */
function cleanJsonResponse(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

async function parseWithPro(promptParts, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.1-pro',
    generationConfig: { responseMimeType: 'application/json' }
  });

  const result = await model.generateContent(promptParts);
  return cleanJsonResponse(result.response.text());
}

/**
 * Parse one or more receipt images using Gemini.
 * @param {Array<{base64: string, mimeType: string}> | string} images - Array of images or legacy single base64 string
 * @param {string} apiKey - Gemini API key
 */
async function parseReceiptFromBase64(images, apiKey) {
  // Backwards compatibility for single string signature (used by some scripts)
  if (typeof images === 'string') {
    images = [{ base64: arguments[0], mimeType: arguments[1] || 'image/jpeg' }];
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const promptParts = images.map(img => ({
    inlineData: { data: img.base64, mimeType: img.mimeType }
  }));
  promptParts.push({ text: PROMPT });

  // Try Flash first
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await model.generateContent(promptParts);
    const parsed = cleanJsonResponse(result.response.text());

    if (parsed.confidence != null && parsed.confidence < 0.8) {
      return await parseWithPro(promptParts, apiKey);
    }

    return parsed;
  } catch (err) {
    // Any failure on Flash → Pro fallback
    return await parseWithPro(promptParts, apiKey);
  }
}

/**
 * Parse receipt from raw pasted text.
 */
async function parseReceiptFromText(text, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash',
    generationConfig: { responseMimeType: 'application/json' }
  });

  const result = await model.generateContent([
    { text: PROMPT },
    { text: `Receipt Text:\n${text}` }
  ]);

  return cleanJsonResponse(result.response.text());
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
