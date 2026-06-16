#!/usr/bin/env node
// Delete receipts from Firestore.
// Usage:
//   node scripts/delete.js --id <docId>          — delete one receipt by Firestore ID
//   node scripts/delete.js --date 2026-05-04     — delete all receipts on a specific date
//   node scripts/delete.js --before 2026-05-04   — delete all receipts before a date
//   node scripts/delete.js --all --confirm       — delete every receipt (requires --confirm)

const admin = require('firebase-admin');
const { initializeAdminApp } = require('../lib/admin');
const readline = require('readline');

initializeAdminApp();
const db = admin.firestore();

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

async function deletedocs(docs, label) {
  if (docs.length === 0) {
    console.log('No receipts matched.');
    return;
  }

  console.log(`\nAbout to delete ${docs.length} receipt(s):`);
  for (const doc of docs) {
    const d = doc.data();
    const date = d.date || d.createdAt?.toDate().toISOString().slice(0, 10) || '?';
    const total = d.total != null ? `$${d.total.toFixed(2)}` : '   ?  ';
    console.log(`  ${doc.id}  ${date}  ${total.padStart(8)}  ${d.merchant || 'Unknown'}`);
  }

  if (!has('--confirm')) {
    const ans = await confirm(`\nDelete these ${docs.length} receipt(s)? (yes/no): `);
    if (ans !== 'yes') { console.log('Aborted.'); process.exit(0); }
  }

  const batch = db.batch();
  for (const doc of docs) batch.delete(doc.ref);
  await batch.commit();
  console.log(`\nDeleted ${docs.length} receipt(s).`);
}

async function run() {
  const id = get('--id');
  const date = get('--date');
  const before = get('--before');
  const all = has('--all');

  if (id) {
    const doc = await db.collection('receipts').doc(id).get();
    if (!doc.exists) { console.error(`No receipt with ID: ${id}`); process.exit(1); }
    await deletedocs([doc], id);
    return;
  }

  if (date) {
    const snap = await db.collection('receipts').where('date', '==', date).get();
    await deletedocs(snap.docs, `date=${date}`);
    return;
  }

  if (before) {
    const snap = await db.collection('receipts').where('date', '<', before).get();
    await deletedocs(snap.docs, `before ${before}`);
    return;
  }

  if (all) {
    const snap = await db.collection('receipts').get();
    await deletedocs(snap.docs, 'all');
    return;
  }

  console.log(`Usage:
  node scripts/delete.js --id <docId>
  node scripts/delete.js --date 2026-05-04
  node scripts/delete.js --before 2026-05-04
  node scripts/delete.js --all --confirm`);
}

run().catch(err => { console.error(err); process.exit(1); });
