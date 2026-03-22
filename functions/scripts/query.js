#!/usr/bin/env node
// Query receipts from Firestore.
// Usage:
//   node scripts/query.js                        — last 20 receipts
//   node scripts/query.js --category Food        — filter by category
//   node scripts/query.js --month 2026-03        — filter by month
//   node scripts/query.js --limit 50

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Look for service account key in a few places
const keyPaths = [
  path.join(__dirname, '..', '..', 'serviceAccountKey.json'),
  path.join(__dirname, '..', 'serviceAccountKey.json'),
  path.join(__dirname, '..', '..', '..', '..', 'Dev', 'Firebase for Transit Stats.json'),
];

let credential;
for (const p of keyPaths) {
  if (fs.existsSync(p)) {
    credential = admin.credential.cert(require(p));
    break;
  }
}

if (!credential) {
  console.error('No service account key found. Place serviceAccountKey.json in the project root.');
  process.exit(1);
}

admin.initializeApp({ credential });
const db = admin.firestore();

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const category = get('--category');
const month = get('--month');   // e.g. 2026-03
const limit = parseInt(get('--limit') || '20', 10);

async function run() {
  let query = db.collection('receipts').orderBy('createdAt', 'desc').limit(limit);

  if (category) query = query.where('category', '==', category);

  const snap = await query.get();
  const receipts = [];

  snap.forEach(doc => {
    const d = doc.data();
    if (month && d.date && !d.date.startsWith(month)) return;
    receipts.push({ id: doc.id, ...d });
  });

  if (receipts.length === 0) {
    console.log('No receipts found.');
    return;
  }

  let total = 0;
  for (const r of receipts) {
    const date = r.date || r.createdAt?.toDate().toISOString().slice(0, 10) || '?';
    const amount = r.total != null ? `$${r.total.toFixed(2)}` : '   ?  ';
    console.log(`${date}  ${amount.padStart(8)}  ${(r.category || '').padEnd(14)}  ${r.merchant || 'Unknown'}`);
    if (r.total) total += r.total;
  }

  console.log('─'.repeat(60));
  console.log(`${receipts.length} receipt(s)   Total: $${total.toFixed(2)}`);
}

run().catch(err => { console.error(err); process.exit(1); });
