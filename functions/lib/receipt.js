const { GoogleGenerativeAI } = require('@google/generative-ai');
const { defineSecret } = require('firebase-functions/params');

const geminiApiKey = defineSecret('GEMINI_API_KEY');

const PROMPT = `Extract the receipt data and return ONLY valid JSON — no markdown, no explanation:
{
  "merchant": "store name",
  "location": "store address or location as printed on receipt, or null",
  "date": "YYYY-MM-DD or null",
  "total": number or null,
  "subtotal": number or null,
  "tax": number or null,
  "category": "one of: Food, Grocery, Transport, Shopping, Entertainment, Health, Other",
  "items": [{ "name": "item name", "price": number }],
  "currency": "CAD"
}
Use null for anything you can't determine. Items can be an empty array.`;

async function parseReceiptFromBase64(base64, mimeType) {
  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType } },
    PROMPT,
  ]);

  const raw = result.response.text().trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(raw);
}

// Used by scripts/test-parse.js
async function parseReceiptFromUrl(imageUrl) {
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) throw new Error(`Failed to fetch image: ${imgResponse.status}`);
  const buffer = await imgResponse.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mimeType = imgResponse.headers.get('content-type') || 'image/jpeg';
  return parseReceiptFromBase64(base64, mimeType);
}

module.exports = { parseReceiptFromBase64, parseReceiptFromUrl };
