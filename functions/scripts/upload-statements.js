#!/usr/bin/env node
/**
 * Import bank and card statements into Slip (CIV-1186). Repeatable: charges
 * already in Slip are left alone, by their saved statement field (account,
 * date, amount, description) and by key.
 *
 * Reads the files (lib/statement-files), loads the account's receipts and
 * rules (statement_rules), then:
 *   - a charge matching a receipt links to it (the receipt gets `statement`)
 *   - an unclear pair marks the receipt for review (`statementReview`)
 *   - other spending, rent, bills, card fees, reloads, transfers and income
 *     are saved as statement entries
 *
 * File names carry account digits, so --accounts gives a JSON file (kept
 * outside the repo) of file-name prefix -> label, used for CSVs and PDFs.
 *
 * Usage:
 *   node scripts/upload-statements.js <files or folders> --phone +14165551234 [--accounts accounts.json]          (dry run)
 *   node scripts/upload-statements.js <files or folders> --phone +14165551234 [--accounts accounts.json] --save
 */
const crypto = require('crypto');
const fs = require('fs');
const { initializeAdminApp } = require('../lib/admin');
const { importReceipt } = require('../lib/import-receipt');
const { listFiles, readStatementFiles } = require('../lib/statement-files');
const {
  classify, alreadyInSlip, matchToReceipts, assignKeys, planEntries, statementField,
} = require('../lib/statement-import');

const TOKEN_ID = 'statement-upload';
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const save = args.includes('--save');
const phone = option('--phone');
const accountsFile = option('--accounts');
const targets = args.filter((arg, index) => !arg.startsWith('--') && !['--phone', '--accounts'].includes(args[index - 1]));

if (!phone || !/^\+\d{10,15}$/.test(phone) || targets.length === 0) {
  console.error('Usage: node scripts/upload-statements.js <files or folders> --phone +14165551234 [--accounts accounts.json] [--save]');
  process.exit(1);
}

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const year = (t) => t.date.slice(0, 4);
const money = (n) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const line = (t) => `${t.date} ${t.account} ${money(t.amount)} ${String(t.description).slice(0, 40)}`;

function count(map, key, field) {
  const row = map[key] = map[key] || {};
  row[field] = (row[field] || 0) + 1;
}

// Keys already claimed in import_idempotency (read only).
async function usedKeys(db, keys) {
  const used = new Set();
  const list = [...new Set(keys)];
  for (let i = 0; i < list.length; i += 300) {
    const part = list.slice(i, i + 300);
    const refs = part.map((key) => db.collection('import_idempotency').doc(`${sha(phone).slice(0, 24)}_${sha(key)}`));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, index) => { if (snap.exists && snap.get('receiptId')) used.add(part[index]); });
  }
  return used;
}

async function main() {
  const accounts = accountsFile ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : {};
  const files = targets.flatMap((target) => listFiles(target));
  const { inventory, transactions, dropped } = readStatementFiles(files, { accounts, labelPdfs: true });

  initializeAdminApp();
  const admin = require('firebase-admin');
  const db = admin.firestore();
  const [receiptSnap, ruleSnap] = await Promise.all([
    db.collection('receipts').where('from', '==', phone).get(),
    db.collection('statement_rules').where('from', '==', phone).get(),
  ]);
  const docs = receiptSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  // Oldest rule first, as statement-rules.js lists them.
  const time = (doc) => doc.get('createdAt')?.toMillis?.() || 0;
  const ruleDocs = [...ruleSnap.docs].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
  const rules = ruleDocs.map((doc) => {
    const { from, createdAt, ...rule } = doc.data();
    return rule;
  });

  transactions.forEach((t) => { t.bucket = classify(t, rules); });
  const keys = assignKeys(transactions, rules);

  // Real receipts: not statement entries. Free ones have no charge linked yet.
  const real = docs.filter((d) => d.importSource?.tokenId !== TOKEN_ID);
  const free = real.filter((d) => !d.statement);
  const inSlip = alreadyInSlip(transactions, docs);
  const open = transactions.filter((t) => !inSlip.has(t));
  const { matches, unclear } = matchToReceipts(open, free, { rules, guardReceipts: real });
  const existingKeys = await usedKeys(db, open.map((t) => keys.get(t)));
  const { entries, skipped, invalid } = planEntries(transactions, { docs, matches, unclear, rules, existingKeys, keys });

  // Report.
  const unread = inventory.filter((e) => !e.parsed);
  const failed = inventory.filter((e) => e.reconciliation && !e.reconciliation.ok);
  console.log(`${files.length} files, ${inventory.length - unread.length} read, ${failed.length} failed to reconcile (left out), ${transactions.length} transactions; ${rules.length} rules`);
  const unreadFormats = {};
  unread.forEach((e) => { unreadFormats[`${e.format} ${e.account || ''}`.trim()] = (unreadFormats[`${e.format} ${e.account || ''}`.trim()] || 0) + 1; });
  if (unread.length) console.log('Not read:', unreadFormats);
  if (dropped.coveredByCsv || dropped.duplicateLines) console.log('Dropped as copies:', dropped);

  const matchedSet = new Set(matches.map((m) => m.transaction));
  const unclearSet = new Set(unclear.map((u) => u.transaction));
  const newSet = new Set(entries.map((e) => e.transaction));
  const status = (t) => {
    if (inSlip.has(t)) return inSlip.get(t).how === 'flagged' ? 'alreadyFlagged' : 'alreadyInSlip';
    if (matchedSet.has(t)) return 'matched';
    if (unclearSet.has(t)) return 'unclear';
    if (newSet.has(t)) return 'new';
    if (t.bucket === 'unknown') return 'unknown';
    return 'skipped';
  };
  const byBucket = {};
  const byYear = {};
  for (const t of transactions) {
    const s = status(t);
    count(byBucket, t.bucket, s);
    count(byYear, year(t), s);
  }
  const totals = {};
  transactions.forEach((t) => { totals[status(t)] = (totals[status(t)] || 0) + 1; });
  console.log('\nTotals:', totals);
  console.log('By bucket:');
  console.table(byBucket);
  console.log('By year:');
  console.table(byYear);
  const flipped = [...inSlip.values()].filter((x) => x.signFlipped && x.how === 'saved');
  if (flipped.length) console.log(`${flipped.length} charges already in Slip were saved with the sign flipped (a charge as a refund or the reverse).`);
  console.log(`Plan: ${entries.length} new entries, ${matches.length} receipts to link, ${unclear.length} unclear pairs; skipped`, skipped);
  for (const item of invalid) console.log(`  invalid: ${line(item.transaction)}: ${item.errors.join('; ')}`);

  const sample = (list, n) => list.filter((_, i) => i % Math.max(1, Math.ceil(list.length / n)) === 0);
  console.log('\nSample new:');
  sample(entries, 15).forEach((e) => console.log(`  ${line(e.transaction)} -> ${e.args.merchant} | ${e.args.category}/${e.args.subCategory || ''} | ${e.args.type}`));
  console.log('Sample matched:');
  sample(matches, 8).forEach((m) => console.log(`  ${line(m.transaction)} = ${m.receipt.date} ${m.receipt.merchant} ${m.receipt.total} ${m.receipt.currency || 'CAD'} (${m.how})`));
  console.log('Sample unclear:');
  sample(unclear, 8).forEach((u) => console.log(`  ${line(u.transaction)} ? ${u.receipt.date} ${u.receipt.merchant} ${u.receipt.total}: ${u.reason}`));

  if (!save) {
    console.log('\nDry run: nothing saved. Add --save to save.');
    return;
  }

  const done = { saved: 0, already: 0, duplicate: 0, failed: 0, linked: 0, marked: 0, markKept: 0 };
  for (const entry of entries) {
    try {
      const result = await importReceipt(
        { from: phone, uid: null, tokenId: TOKEN_ID },
        entry.args,
        { receivedAt: new Date(`${entry.args.date}T12:00:00`), skipRateLimit: true, skipResendCheck: true },
      );
      if (result.deduplicated) done.already++;
      else if (result.duplicate) done.duplicate++;
      else {
        await db.collection('receipts').doc(result.receiptId).update({ statement: entry.statement });
        done.saved++;
      }
    } catch (err) {
      done.failed++;
      console.log(`  failed: ${line(entry.transaction)}: ${err.message}`);
    }
  }
  for (const m of matches) {
    await db.collection('receipts').doc(m.receipt.id).update({ statement: statementField(m.transaction) });
    done.linked++;
  }
  // One mark per receipt; a receipt that already has one keeps it.
  const marked = new Set();
  for (const u of unclear) {
    if (u.receipt.statementReview || marked.has(u.receipt.id)) { done.markKept++; continue; }
    await db.collection('receipts').doc(u.receipt.id).update({ statementReview: { reason: u.reason, charge: statementField(u.transaction) } });
    marked.add(u.receipt.id);
    done.marked++;
  }
  console.log('\nSaved:', done);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
