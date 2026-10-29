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



// A hard duplicate: the same message/import being processed again, or the same
// merchant + total submitted within DUPLICATE_WINDOW_MS (rapid re-sends). These
// are dropped. Returns the existing receipt id, or null.
// `messagePart` numbers the receipts in a text that held several; the same
// message only counts as a resend for the same part.
async function findDuplicate(receipt, from, { messageSid, messagePart } = {}) {
  const db = admin.firestore();

  if (messageSid) {
    const sidSnap = await db.collection('receipts')
      .where('from', '==', from)
      .where('messageSid', '==', messageSid)
      .get();
    const samePart = sidSnap.docs.find((doc) => (doc.get('messagePart') ?? null) === (messagePart ?? null));
    if (samePart) return samePart.id;
  }

  if (!receipt.merchant || receipt.total == null) return null;
  const merchantKey = receipt.merchant.trim().toLowerCase();

  const windowStart = new Date(Date.now() - config.DUPLICATE_WINDOW_MS);
  const recentSnap = await db.collection('receipts')
    .where('from', '==', from)
    .where('merchantKey', '==', merchantKey)
    .where('total', '==', receipt.total)
    .where('createdAt', '>=', windowStart)
    .limit(1)
    .get();
  if (!recentSnap.empty) return recentSnap.docs[0].id;

  return null;
}

// A possible duplicate: same merchant + total + receipt date, but saved outside
// the rapid-resend window. These are real repeats often enough (two identical
// coffees) that they are saved and flagged rather than dropped. Returns the
// earlier receipt id, or null.
async function findPossibleDuplicate(receipt, from) {
  if (!receipt.merchant || receipt.total == null || !receipt.date) return null;

  const snap = await admin.firestore().collection('receipts')
    .where('from', '==', from)
    .where('merchantKey', '==', receipt.merchant.trim().toLowerCase())
    .where('total', '==', receipt.total)
    .where('date', '==', receipt.date)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

// The stored shape of a new receipt; every path that creates one uses it.
function receiptRecord(receipt, from, messageSid, imagePaths = [], extra = {}) {
  return {
    ...receipt,
    merchantKey: receipt.merchant ? receipt.merchant.trim().toLowerCase() : null,
    from,
    messageSid: messageSid || null,
    imagePaths,
    ...extra,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function saveReceipt(receipt, from, messageSid, imagePaths = [], extra = {}) {
  const doc = await admin.firestore().collection('receipts').add(receiptRecord(receipt, from, messageSid, imagePaths, extra));
  return doc.id;
}

async function saveProcessingFailure({ from, messageSid, error, imagePaths = [], numMedia = 0, sourceText, messagePart }) {
  const db = admin.firestore();
  const data = {
    from,
    messageSid: messageSid || null,
    status: 'failed',
    error: error || 'Unknown receipt processing error',
    imagePaths,
    numMedia,
    // Pasted receipt text (text-only messages), capped, so the failure can be retried.
    ...(typeof sourceText === 'string' && sourceText.trim() ? { sourceText: sourceText.slice(0, config.MAX_BODY_TEXT_LENGTH) } : {}),
    ...(messagePart != null ? { messagePart } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (messageSid) {
    // One failure per receipt: a text with several receipts can fail on more than one.
    const id = messagePart != null ? `${messageSid}-${messagePart}` : messageSid;
    await db.collection('processing_failures').doc(id).set({
      ...data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return id;
  }

  const doc = await db.collection('processing_failures').add({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return doc.id;
}

module.exports = { receiptRecord, saveReceipt, saveProcessingFailure, findDuplicate, findPossibleDuplicate, isMessageProcessed, checkRateLimit, countRecentReceipts };
