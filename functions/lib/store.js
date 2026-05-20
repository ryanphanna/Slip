const admin = require('firebase-admin');

function countRecentReceipts(snapshotDocs, from, oneHourAgo, limit) {
  let recentCount = 0;
  for (const doc of snapshotDocs) {
    if (doc.get('from') !== from) continue;
    const createdAt = doc.get('createdAt');
    const createdAtDate = createdAt?.toDate?.();
    if (!createdAtDate || createdAtDate < oneHourAgo) continue;
    recentCount += 1;
    if (recentCount >= limit) return true;
  }

  return false;
}

async function isMessageProcessed(messageSid) {
  if (!messageSid) return false;
  const db = admin.firestore();
  const snapshot = await db.collection('receipts')
    .where('messageSid', '==', messageSid)
    .limit(1)
    .get();
  return !snapshot.empty;
}

async function checkRateLimit(from, limit = 15) {
  const db = admin.firestore();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const snapshot = await db.collection('receipts')
    .orderBy('createdAt', 'desc')
    .limit(Math.max(limit * 10, 50))
    .get();

  return countRecentReceipts(snapshot.docs, from, oneHourAgo, limit);
}

async function findDuplicate(receipt, from) {
  if (!receipt.merchant || receipt.total == null) return null;

  const db = admin.firestore();
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('merchant', '==', receipt.merchant)
    .where('total', '==', receipt.total)
    .where('createdAt', '>=', tenMinutesAgo)
    .limit(1)
    .get();

  return !snapshot.empty ? snapshot.docs[0].id : null;
}

async function saveReceipt(receipt, from, messageSid, imagePaths = []) {
  const db = admin.firestore();
  const doc = await db.collection('receipts').add({
    ...receipt,
    from,
    messageSid: messageSid || null,
    imagePaths,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return doc.id;
}

module.exports = { saveReceipt, findDuplicate, isMessageProcessed, checkRateLimit, countRecentReceipts };
