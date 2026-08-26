const admin = require('firebase-admin');
const config = require('./config');

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

async function checkRateLimit(from) {
  const db = admin.firestore();
  const oneHourAgo = new Date(Date.now() - config.RATE_LIMIT_WINDOW_MS);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', twentyFourHoursAgo)
    .get();

  const dailyCount = snapshot.size;
  if (dailyCount >= config.RATE_LIMIT_PER_DAY) {
    return { exceeded: true, reason: 'daily' };
  }

  let hourlyCount = 0;
  for (const doc of snapshot.docs) {
    const createdAt = doc.get('createdAt')?.toDate?.();
    if (createdAt && createdAt >= oneHourAgo) {
      hourlyCount++;
    }
  }

  if (hourlyCount >= config.RATE_LIMIT_PER_HOUR) {
    return { exceeded: true, reason: 'hourly' };
  }

  return { exceeded: false };
}



async function findDuplicate(receipt, from) {
  if (!receipt.merchant || receipt.total == null) return null;

  const db = admin.firestore();
  const merchantKey = receipt.merchant.trim().toLowerCase();

  // 1. Same merchant + total submitted within the time window (catches rapid re-sends)
  const tenMinutesAgo = new Date(Date.now() - config.DUPLICATE_WINDOW_MS);
  const recentSnap = await db.collection('receipts')
    .where('from', '==', from)
    .where('merchantKey', '==', merchantKey)
    .where('total', '==', receipt.total)
    .where('createdAt', '>=', tenMinutesAgo)
    .limit(1)
    .get();
  if (!recentSnap.empty) return recentSnap.docs[0].id;

  // 2. Same merchant + total + receipt date (catches re-uploads of old receipts days later)
  if (receipt.date) {
    const dateSnap = await db.collection('receipts')
      .where('from', '==', from)
      .where('merchantKey', '==', merchantKey)
      .where('total', '==', receipt.total)
      .where('date', '==', receipt.date)
      .limit(1)
      .get();
    if (!dateSnap.empty) return dateSnap.docs[0].id;
  }

  return null;
}

async function saveReceipt(receipt, from, messageSid, imagePaths = []) {
  const db = admin.firestore();
  const doc = await db.collection('receipts').add({
    ...receipt,
    merchantKey: receipt.merchant ? receipt.merchant.trim().toLowerCase() : null,
    from,
    messageSid: messageSid || null,
    imagePaths,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return doc.id;
}

async function saveProcessingFailure({ from, messageSid, error, imagePaths = [], numMedia = 0 }) {
  const db = admin.firestore();
  const data = {
    from,
    messageSid: messageSid || null,
    status: 'failed',
    error: error || 'Unknown receipt processing error',
    imagePaths,
    numMedia,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (messageSid) {
    await db.collection('processing_failures').doc(messageSid).set({
      ...data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return messageSid;
  }

  const doc = await db.collection('processing_failures').add({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return doc.id;
}

module.exports = { saveReceipt, saveProcessingFailure, findDuplicate, isMessageProcessed, checkRateLimit, countRecentReceipts };
