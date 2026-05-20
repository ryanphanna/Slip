const admin = require('firebase-admin');

function findLatestReceiptForSender(snapshotDocs, from) {
  for (const doc of snapshotDocs) {
    if (doc.get('from') === from) return doc.data();
  }
  return null;
}

async function getMonthlyStats(from) {
  const db = admin.firestore();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', startOfMonth)
    .orderBy('createdAt', 'desc')
    .get();

  let total = 0;
  const categories = {};
  let count = 0;

  snapshot.forEach(doc => {
    const data = doc.data();
    const amount = data.total || 0;
    total += amount;
    count++;

    const cat = data.category || 'Other';
    categories[cat] = (categories[cat] || 0) + amount;
  });

  return { total, categories, count, month: now.toLocaleString('default', { month: 'long' }) };
}

async function getLastReceipt(from) {
  const db = admin.firestore();
  const snapshot = await db.collection('receipts')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  return findLatestReceiptForSender(snapshot.docs, from);
}

module.exports = { getMonthlyStats, getLastReceipt, findLatestReceiptForSender };
