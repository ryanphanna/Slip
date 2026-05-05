#!/usr/bin/env node
// Test receipt parsing locally against one or more image files.
// Usage:
//   GEMINI_API_KEY=... node scripts/test-parse.js /path/to/receipt.jpg
//   GEMINI_API_KEY=... node scripts/test-parse.js img1.jpg img2.jpg img3.jpg

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY env var first.');
  process.exit(1);
}

const imagePaths = process.argv.slice(2);
if (imagePaths.length === 0) {
  console.error('Usage: node scripts/test-parse.js /path/to/receipt.jpg [img2.jpg ...]');
  process.exit(1);
}

const mimeTypeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif' };

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
  "loyaltyPointsBalance": number or null
}
Use null for anything you can't determine. Items can be an empty array.
For each item, record the final net price paid after any inline per-item discount shown beneath it on the receipt. Do not add a separate line item for any discount summary or coupon total that appears at the bottom — if per-item discounts are already reflected in individual prices, the summary line is redundant and should be omitted.`;

async function run() {
  const images = imagePaths.map(p => {
    const ext = path.extname(p).toLowerCase();
    return {
      name: path.basename(p),
      base64: fs.readFileSync(p).toString('base64'),
      mimeType: mimeTypeMap[ext] || 'image/jpeg',
    };
  });

  console.log(`Parsing ${images.map(i => i.name).join(', ')}...\n`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const parts = [
    ...images.map(img => ({ inlineData: { data: img.base64, mimeType: img.mimeType } })),
    { text: PROMPT },
  ];

  const result = await model.generateContent(parts);
  const raw = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const receipt = JSON.parse(raw);
  console.log(JSON.stringify(receipt, null, 2));

  if (receipt.items?.length) {
    const itemSum = receipt.items.reduce((a, i) => a + (i.price || 0), 0);
    console.log(`\nItems sum: $${itemSum.toFixed(2)}  |  Subtotal: $${receipt.subtotal ?? '?'}  |  Total: $${receipt.total ?? '?'}`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
