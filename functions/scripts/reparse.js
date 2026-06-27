#!/usr/bin/env node
// Re-parse one or more receipts from their stored images and update Firestore.
// Usage:
//   node scripts/reparse.js <docId> [<docId> ...]
//   node scripts/reparse.js --dry-run <docId>

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const admin = require('firebase-admin');
const { initializeAdminApp } = require('../lib/admin');

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function getSecret(name) {
  const version = process.env.SMOKE_SECRET_VERSION || '1';
  try {
    return execFileSync('firebase', ['functions:secrets:access', `${name}@${version}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) { return ''; }
}

function getConfig(name) {
  return process.env[name] || getSecret(name) || '';
}

loadDotenv(path.join(__dirname, '..', '.env'));
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || getConfig('GEMINI_API_KEY');

initializeAdminApp();
const db = admin.firestore();

const { parseReceiptFromBase64 } = require('../lib/receipt');
const { validateReceipt } = require('../lib/validate');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const docIds = args.filter(a => !a.startsWith('--'));

if (docIds.length === 0) {
  console.error('Usage: node scripts/reparse.js [--dry-run] <docId> [<docId> ...]');
  process.exit(1);
}

async function downloadImage(imagePath) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(imagePath);
  const [buffer] = await file.download();
  const [meta] = await file.getMetadata();
  const mimeType = meta.contentType || 'image/jpeg';
  return { base64: buffer.toString('base64'), mimeType };
}

const RECEIPT_FIELDS = ['merchant', 'location', 'date', 'total', 'subtotal', 'tax', 'category',
  'subCategory', 'currency', 'type', 'isSubscription', 'loyaltyPointsEarned', 'loyaltyPointsBalance',
  'confidence', 'items'];

function diff(before, after) {
  const changes = [];
  for (const key of RECEIPT_FIELDS) {
    if (key === 'items') continue;
    const bv = JSON.stringify(before[key] ?? null);
    const av = JSON.stringify(after[key] ?? null);
    if (bv !== av) changes.push(`  ${key}: ${bv} → ${av}`);
  }
  const bi = JSON.stringify(before.items || []);
  const ai = JSON.stringify(after.items || []);
  if (bi !== ai) changes.push(`  items: ${before.items?.length ?? 0} items → ${after.items?.length ?? 0} items`);
  return changes;
}

async function reparse(docId) {
  const docRef = db.collection('receipts').doc(docId);
  const snap = await docRef.get();

  if (!snap.exists) {
    console.error(`[${docId}] Not found in Firestore.`);
    return;
  }

  const existing = snap.data();
  const imagePaths = existing.imagePaths || [];

  if (imagePaths.length === 0) {
    console.error(`[${docId}] No stored images — cannot re-parse.`);
    return;
  }

  console.log(`[${docId}] Downloading ${imagePaths.length} image(s)...`);
  const images = await Promise.all(imagePaths.map(downloadImage));

  console.log(`[${docId}] Parsing with Gemini...`);
  const raw = await parseReceiptFromBase64(images);
  const receipt = validateReceipt(raw);
  if (raw.confidence != null) receipt.confidence = raw.confidence;

  const changes = diff(existing, receipt);

  if (changes.length === 0) {
    console.log(`[${docId}] No changes — parse result identical to stored data.`);
    return;
  }

  console.log(`[${docId}] Changes:`);
  changes.forEach(c => console.log(c));

  if (dryRun) {
    console.log(`[${docId}] Dry run — Firestore not updated.`);
    return;
  }

  await docRef.update({
    ...receipt,
    reparsedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`[${docId}] Updated.`);
}

async function main() {
  for (const id of docIds) {
    try {
      await reparse(id);
    } catch (err) {
      console.error(`[${id}] Failed: ${err.message}`);
    }
  }
  process.exit(0);
}

main();
