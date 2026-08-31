#!/usr/bin/env node
// Attach existing SMS data to a verified Firebase Auth account.
// Usage: node scripts/migrate-to-accounts.js --phone +14165551234 --uid <firebase-uid> [--apply]

const admin = require('firebase-admin');
const { initializeAdminApp } = require('../lib/admin');

initializeAdminApp();
const db = admin.firestore();
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index === -1 ? '' : args[index + 1]; };
const phone = value('--phone');
const uid = value('--uid');
const apply = args.includes('--apply');

if (!phone || !uid) {
  console.error('Usage: node scripts/migrate-to-accounts.js --phone <E.164> --uid <firebase-uid> [--apply]');
  process.exit(1);
}

async function migrateCollection(name) {
  const snapshot = await db.collection(name).where('from', '==', phone).get();
  console.log(`${name}: ${snapshot.size} matching records${apply ? '' : ' (dry run)'}`);
  if (!apply) return;

  const batches = [];
  let batch = db.batch();
  let count = 0;
  for (const doc of snapshot.docs) {
    batch.set(doc.ref, { ownerUid: uid }, { merge: true });
    count += 1;
    if (count === 400) { batches.push(batch.commit()); batch = db.batch(); count = 0; }
  }
  if (count > 0) batches.push(batch.commit());
  await Promise.all(batches);
}

async function run() {
  await migrateCollection('receipts');
  await migrateCollection('processing_failures');
  const budgets = await db.collection('budgets').where('from', '==', phone).get();
  console.log(`budgets: ${budgets.size} matching records${apply ? '' : ' (dry run)'}`);
  if (apply) await Promise.all(budgets.docs.map((doc) => doc.ref.set({ ownerUid: uid }, { merge: true })));
}

run().catch((error) => { console.error(error); process.exit(1); });
