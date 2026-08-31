const admin = require('firebase-admin');
const { validateReceipt } = require('./validate');
const { parseReceiptFromBase64 } = require('./receipt');

const EDITABLE_FIELDS = new Set([
  'merchant', 'location', 'date', 'total', 'subtotal', 'tax', 'category',
  'subCategory', 'currency', 'type', 'isSubscription', 'loyaltyPointsEarned',
  'loyaltyPointsBalance', 'items',
]);

function requireAuth(request) {
  if (!request.auth?.uid || !request.auth.token?.phone_number) {
    const error = new Error('Authentication required');
    error.code = 'unauthenticated';
    throw error;
  }
  return { uid: request.auth.uid, phone: request.auth.token.phone_number };
}

function cleanPatch(data) {
  return Object.fromEntries(Object.entries(data || {}).filter(([key]) => EDITABLE_FIELDS.has(key)));
}

function serializeDoc(doc) {
  const data = doc.data();
  return { id: doc.id, ...data };
}

function receiptQuery(db, uid, phone) {
  // `from` keeps historical records visible until the migration script has run.
  return db.collection('receipts').where('from', '==', phone).orderBy('createdAt', 'desc');
}

async function listReceipts(request) {
  const { uid, phone } = requireAuth(request);
  const db = admin.firestore();
  const options = request.data || {};
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
  let query = receiptQuery(db, uid, phone).limit(limit + 1);

  if (options.category) query = query.where('category', '==', String(options.category));
  if (options.merchant) query = query.where('merchantKey', '==', String(options.merchant).trim().toLowerCase());
  if (options.startDate) query = query.where('date', '>=', String(options.startDate));
  if (options.endDate) query = query.where('date', '<=', String(options.endDate));

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);
  return {
    receipts: docs.map(serializeDoc),
    hasMore: snapshot.docs.length > limit,
    accountUid: uid,
  };
}

async function getReceipt(request) {
  const { phone } = requireAuth(request);
  const id = String(request.data?.id || '');
  if (!id) throw new Error('Receipt id is required');
  const doc = await admin.firestore().collection('receipts').doc(id).get();
  if (!doc.exists || doc.get('from') !== phone) {
    const error = new Error('Receipt not found');
    error.code = 'not-found';
    throw error;
  }
  return serializeDoc(doc);
}

async function updateReceipt(request) {
  const { phone } = requireAuth(request);
  const id = String(request.data?.id || '');
  if (!id) throw new Error('Receipt id is required');
  const ref = admin.firestore().collection('receipts').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.get('from') !== phone) {
    const error = new Error('Receipt not found');
    error.code = 'not-found';
    throw error;
  }

  const patch = cleanPatch(request.data?.patch);
  const next = validateReceipt({ ...snapshot.data(), ...patch });
  await ref.set({ ...next, editedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { id, ...next };
}

async function getReceiptImageUrls(request) {
  const { phone } = requireAuth(request);
  const id = String(request.data?.id || '');
  const doc = await admin.firestore().collection('receipts').doc(id).get();
  if (!doc.exists || doc.get('from') !== phone) {
    const error = new Error('Receipt not found');
    error.code = 'not-found';
    throw error;
  }

  const bucket = admin.storage().bucket();
  const urls = await Promise.all((doc.get('imagePaths') || []).map(async (path) => {
    const file = bucket.file(path);
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata();
    const mimeType = metadata.contentType || 'image/jpeg';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }));
  return { urls };
}

async function listProcessingFailures(request) {
  const { phone } = requireAuth(request);
  const snapshot = await admin.firestore().collection('processing_failures')
    .where('from', '==', phone)
    .limit(50)
    .get();
  const failures = snapshot.docs.map(serializeDoc);
  failures.sort((a, b) => {
    const aTime = a.createdAt?.toMillis?.() || 0;
    const bTime = b.createdAt?.toMillis?.() || 0;
    return bTime - aTime;
  });
  return { failures };
}

async function retryProcessing(request) {
  const { phone } = requireAuth(request);
  const id = String(request.data?.id || '');
  const failureRef = admin.firestore().collection('processing_failures').doc(id);
  const failure = await failureRef.get();
  if (!failure.exists || failure.get('from') !== phone) {
    const error = new Error('Processing failure not found');
    error.code = 'not-found';
    throw error;
  }
  const paths = failure.get('imagePaths') || [];
  if (paths.length === 0) throw new Error('This failure has no stored image to retry');

  const bucket = admin.storage().bucket();
  const images = await Promise.all(paths.map(async (path) => {
    const file = bucket.file(path);
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata();
    return { base64: buffer.toString('base64'), mimeType: metadata.contentType || 'image/jpeg' };
  }));
  const raw = await parseReceiptFromBase64(images);
  const receipt = validateReceipt(raw);
  if (raw.confidence != null) receipt.confidence = raw.confidence;
  const ref = await admin.firestore().collection('receipts').add({
    ...receipt,
    from: phone,
    ownerUid: request.auth.uid,
    messageSid: failure.get('messageSid') || null,
    imagePaths: paths,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    recoveredFromFailure: id,
  });
  await failureRef.set({ status: 'recovered', recoveredReceiptId: ref.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { id: ref.id, ...receipt };
}

module.exports = {
  EDITABLE_FIELDS,
  requireAuth,
  cleanPatch,
  listReceipts,
  getReceipt,
  updateReceipt,
  getReceiptImageUrls,
  listProcessingFailures,
  retryProcessing,
};
