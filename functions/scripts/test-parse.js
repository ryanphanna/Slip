#!/usr/bin/env node
// Test receipt parsing locally against a real image file.
// Usage: ANTHROPIC_API_KEY=sk-... node scripts/test-parse.js /path/to/receipt.jpg

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY env var first.');
  process.exit(1);
}

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: node scripts/test-parse.js /path/to/receipt.jpg');
  process.exit(1);
}

const ext = path.extname(imagePath).toLowerCase();
const mediaTypeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const mediaType = mediaTypeMap[ext] || 'image/jpeg';

const base64 = fs.readFileSync(imagePath).toString('base64');
const client = new Anthropic({ apiKey });

async function run() {
  console.log(`Parsing ${path.basename(imagePath)}...\n`);

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `Extract the receipt data and return ONLY valid JSON — no markdown, no explanation:
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
Use null for anything you can't determine. Items can be an empty array.`,
        },
      ],
    }],
  });

  const raw = message.content[0].text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  const receipt = JSON.parse(raw);
  console.log(JSON.stringify(receipt, null, 2));
}

run().catch(err => { console.error(err); process.exit(1); });
