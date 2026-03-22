const admin = require('firebase-admin');

async function saveReceipt(receipt, from) {
  const db = admin.firestore();
  const doc = await db.collection('receipts').add({
    ...receipt,
    from,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return doc.id;
}

module.exports = { saveReceipt };
