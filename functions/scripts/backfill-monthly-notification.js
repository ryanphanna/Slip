#!/usr/bin/env node
// Backfill a monthly recap notification from receipt purchase dates.
// Usage: node scripts/backfill-monthly-notification.js --phone +14165551234 --month 2026-08

const admin = require('firebase-admin');
const { initializeAdminApp } = require('../lib/admin');
const { aggregateSpendingByCategory } = require('../lib/query');

initializeAdminApp();
const db = admin.firestore();
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index === -1 ? '' : args[index + 1]; };
const phone = value('--phone');
const monthKey = value('--month');

if (!phone || !/^\d{4}-\d{2}$/.test(monthKey)) {
  console.error('Usage: node scripts/backfill-monthly-notification.js --phone <E.164> --month YYYY-MM');
  process.exit(1);
}

async function run() {
  const start = `${monthKey}-01`;
  const [year, month] = monthKey.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 1));
  const endKey = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const snapshot = await db.collection('receipts').where('from', '==', phone).get();
  const docs = snapshot.docs.map((doc) => doc.data()).filter((doc) => doc.date >= start && doc.date < endKey);
  const { total, categories } = aggregateSpendingByCategory(docs);
  if (docs.length === 0) throw new Error(`No receipts found for ${monthKey}`);

  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-CA', { month: 'long', timeZone: 'UTC' });
  const receiptWord = docs.length === 1 ? 'receipt' : 'receipts';
  const breakdown = Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([category, amount]) => `${category}: $${amount.toFixed(2)}`).join('\n');
  const message = `${monthName} recap: $${total.toFixed(2)} across ${docs.length} ${receiptWord}\n\n${breakdown}`;
  const id = `${phone.replace(/\D/g, '')}_${monthKey}`;
  await db.collection('notifications').doc(id).set({ from: phone, type: 'monthlyDigest', title: `${monthName} recap`, month: monthName, monthKey, total, count: docs.length, categories, message, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log(`${monthName} recap saved: $${total.toFixed(2)} across ${docs.length} ${receiptWord}`);
}

run().catch((error) => { console.error(error); process.exit(1); });
