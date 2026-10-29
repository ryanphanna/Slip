#!/usr/bin/env node
/**
 * Upload a receipts file made by an AI assistant from receipt emails
 * (format: docs/AI_RECEIPTS.md). Each receipt goes through the same
 * validation, checks and idempotency as an AI import, without the hourly
 * import limits, so a large backlog can be loaded in one go.
 *
 * Usage:
 *   node scripts/upload-receipts.js <file.json> [more.json] --phone +14165551234          (dry run)
 *   node scripts/upload-receipts.js <file.json> [more.json] --phone +14165551234 --save
 */
const fs = require('fs');
const { initializeAdminApp } = require('../lib/admin');
const { validateImport } = require('../lib/import-schema');
const { isRealDate } = require('../lib/validate');

const args = process.argv.slice(2);
const save = args.includes('--save');
const phoneIndex = args.indexOf('--phone');
const phone = phoneIndex >= 0 ? args[phoneIndex + 1] : null;
const files = args.filter((arg, index) => !arg.startsWith('--') && index !== phoneIndex + 1);

if (!phone || !/^\+\d{10,15}$/.test(phone) || files.length === 0) {
  console.error('Usage: node scripts/upload-receipts.js <file.json> [more.json] --phone +14165551234 [--save]');
  process.exit(1);
}

// Splits one file entry into the create_receipt fields and the email's date.
function readEntry(entry) {
  const { emailDate, ...receipt } = entry || {};
  if (!receipt.source) receipt.source = { client: 'email-file' };
  if (receipt.schemaVersion === undefined) receipt.schemaVersion = 1;
  const receivedAt = isRealDate(emailDate) ? new Date(`${emailDate}T12:00:00`) : undefined;
  return { receipt, receivedAt };
}

function loadFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { receipts: Array.isArray(data.receipts) ? data.receipts : [], skipped: Array.isArray(data.skipped) ? data.skipped : [] };
}

async function main() {
  const entries = [];
  let skippedByAssistant = 0;
  for (const file of files) {
    const { receipts, skipped } = loadFile(file);
    skippedByAssistant += skipped.length;
    receipts.forEach((entry, index) => entries.push({ file, index, ...readEntry(entry) }));
  }

  const invalid = [];
  const valid = [];
  for (const entry of entries) {
    const { errors } = validateImport(entry.receipt);
    (errors.length ? invalid : valid).push({ ...entry, errors });
  }

  console.log(`${entries.length} receipts in ${files.length} file(s); ${valid.length} valid, ${invalid.length} invalid; ${skippedByAssistant} skipped by the assistant.`);
  for (const entry of invalid) {
    console.log(`  invalid: ${entry.file} #${entry.index + 1} ${entry.receipt.merchant || '?'} ${entry.receipt.date || ''}: ${entry.errors.join('; ')}`);
  }
  if (!save) {
    console.log('Dry run: nothing saved. Add --save to upload the valid receipts.');
    return;
  }

  initializeAdminApp();
  const { importReceipt } = require('../lib/import-receipt');
  const identity = { from: phone, uid: null, tokenId: 'local-upload' };
  const counts = { saved: 0, alreadyImported: 0, duplicate: 0, failed: 0, marked: 0 };
  for (const entry of valid) {
    try {
      const result = await importReceipt(identity, entry.receipt, { receivedAt: entry.receivedAt, skipRateLimit: true });
      if (result.deduplicated) counts.alreadyImported += 1;
      else if (result.duplicate) counts.duplicate += 1;
      else counts.saved += 1;
      if (!result.deduplicated && result.warnings.some((w) => w.includes('marked for checking'))) counts.marked += 1;
    } catch (error) {
      counts.failed += 1;
      console.log(`  failed: ${entry.file} #${entry.index + 1} ${entry.receipt.merchant}: ${error.message}`);
    }
  }
  console.log(`Saved ${counts.saved} (${counts.marked} marked for checking), ${counts.alreadyImported} already imported, ${counts.duplicate} duplicates, ${counts.failed} failed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
