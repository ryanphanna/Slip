const admin = require('firebase-admin');

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

module.exports = { saveReceipt, findDuplicate };
