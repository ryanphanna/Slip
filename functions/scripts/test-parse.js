#!/usr/bin/env node
// Test receipt parsing locally against a real image file.
// Usage: GEMINI_API_KEY=... node scripts/test-parse.js /path/to/receipt.jpg

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY env var first.');
  process.exit(1);
}

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: node scripts/test-parse.js /path/to/receipt.jpg');
  process.exit(1);
}

const ext = path.extname(imagePath).toLowerCase();
const mimeTypeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const mimeType = mimeTypeMap[ext] || 'image/jpeg';

const base64 = fs.readFileSync(imagePath).toString('base64');

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
  "currency": "Currency code (e.g. CAD, USD, EUR). Infer from location if implied.",
  "type": "purchase or refund",
  "loyaltyPointsEarned": number or null,
  "loyaltyPointsBalance": number or null
}
Use null for anything you can't determine. Items can be an empty array.`;

async function run() {
  console.log(`Parsing ${path.basename(imagePath)}...\n`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType } },
    PROMPT,
  ]);

  const raw = result.response.text().trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  const receipt = JSON.parse(raw);
  console.log(JSON.stringify(receipt, null, 2));
}

run().catch(err => { console.error(err); process.exit(1); });
