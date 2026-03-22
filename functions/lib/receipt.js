const { GoogleGenerativeAI } = require('@google/generative-ai');
const { defineSecret } = require('firebase-functions/params');

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');

const PROMPT = `Extract the receipt data and return ONLY valid JSON — no markdown, no explanation:
{
  "merchant": "store name",
  "date": "YYYY-MM-DD or null",
  "total": number or null,
  "subtotal": number or null,
  "tax": number or null,
  "category": "one of: Food, Grocery, Transport, Shopping, Entertainment, Health, Other",
  "items": [{ "name": "item name", "price": number }],
  "currency": "CAD"
}
Use null for anything you can't determine. Items can be an empty array.`;

async function parseReceiptFromUrl(mediaUrl) {
  // Twilio media URLs require HTTP Basic auth
  const auth = Buffer.from(
    `${twilioAccountSid.value()}:${twilioAuthToken.value()}`
  ).toString('base64');

  const imgResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!imgResponse.ok) {
    throw new Error(`Failed to fetch media: ${imgResponse.status}`);
  }

  const buffer = await imgResponse.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mimeType = imgResponse.headers.get('content-type') || 'image/jpeg';

  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType } },
    PROMPT,
  ]);

  const raw = result.response.text().trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(raw);
}

module.exports = { parseReceiptFromUrl };
