#!/usr/bin/env node
// Test receipt parsing locally against one or more image files.
// Usage:
//   GEMINI_API_KEY=... node scripts/test-parse.js /path/to/receipt.jpg
//   GEMINI_API_KEY=... node scripts/test-parse.js img1.jpg img2.jpg img3.jpg

const fs = require('fs');
const path = require('path');

// Use the shared authoritative prompt + parsing logic (Flash with Pro fallback).
// This removes the previous duplication with lib/receipt.js.
const { PROMPT, parseReceiptFromBase64 } = require('../lib/gemini');

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

  // Shared implementation now gives us the full production path (including Pro fallback on low confidence)
  const receipt = await parseReceiptFromBase64(images, apiKey);

  console.log(JSON.stringify(receipt, null, 2));

  if (receipt.items?.length) {
    const itemSum = receipt.items.reduce((a, i) => a + (i.price || 0), 0);
    console.log(`\nItems sum: $${itemSum.toFixed(2)}  |  Subtotal: $${receipt.subtotal ?? '?'}  |  Total: $${receipt.total ?? '?'}`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
