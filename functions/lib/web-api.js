const admin = require('firebase-admin');
const crypto = require('node:crypto');
const { validateReceipt } = require('./validate');
const { parseReceiptFromBase64 } = require('./receipt');

const EDITABLE_FIELDS = new Set([
  'merchant', 'location', 'date', 'total', 'subtotal', 'tax', 'category',
  'subCategory', 'currency', 'type', 'isSubscription', 'loyaltyPointsEarned',
  'loyaltyPointsBalance', 'items',
]);
const VISIBLE_FAILURE_STATUSES = new Set(['failed', 'pending', '', 'resolved', 'duplicate']);

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

async function loadImageUrls(bucket, paths) {
  const results = await Promise.allSettled(paths.map(async (path) => {
    const file = bucket.file(path);
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata();
    return `data:${metadata.contentType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  }));
  return results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
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
  const urls = await loadImageUrls(bucket, doc.get('imagePaths') || []);
  return { urls };
}

async function listProcessingFailures(request) {
  const { phone } = requireAuth(request);
  const snapshot = await admin.firestore().collection('processing_failures')
    .where('from', '==', phone)
    .limit(50)
    .get();
  const failures = snapshot.docs.map(serializeDoc)
    .filter((failure) => VISIBLE_FAILURE_STATUSES.has(failure.status || '')
      && Array.isArray(failure.imagePaths)
      && failure.imagePaths.length > 0);
  failures.sort((a, b) => {
    const aTime = a.createdAt?.toMillis?.() || 0;
    const bTime = b.createdAt?.toMillis?.() || 0;
    return bTime - aTime;
  });
  return { failures };
}

async function getProcessingFailureImageUrls(request) {
  const { phone } = requireAuth(request);
  const id = String(request.data?.id || '');
  const doc = await admin.firestore().collection('processing_failures').doc(id).get();
  if (!doc.exists || doc.get('from') !== phone) {
    const error = new Error('Processing failure not found');
    error.code = 'not-found';
    throw error;
  }
  const bucket = admin.storage().bucket();
  const urls = await loadImageUrls(bucket, doc.get('imagePaths') || []);
  return { urls };
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

function canonicalItemId(phone, merchant, item) {
  const identity = item.itemNumber || item.productUrl || item.publicName || item.name;
  return crypto.createHash('sha256').update(`${phone}|${merchant}|${String(identity).trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

async function importTargetReceipts(request) {
  const { uid, phone } = requireAuth(request);
  const records = request.data?.receipts;
  if (!Array.isArray(records) || records.length === 0 || records.length > 100) {
    const error = new Error('Provide between 1 and 100 Target receipts');
    error.code = 'invalid-argument';
    throw error;
  }

  const db = admin.firestore();
  const imported = [];
  const skipped = [];
  for (const record of records) {
    if (String(record.merchant || '').trim().toLowerCase() !== 'target' || !record.sourceOrderId) {
      const error = new Error('Each import record must be a Target receipt with a sourceOrderId');
      error.code = 'invalid-argument';
      throw error;
    }
    const existing = await db.collection('receipts')
      .where('from', '==', phone)
      .where('sourceOrderId', '==', String(record.sourceOrderId))
      .limit(1)
      .get();
    const receipt = validateReceipt({ ...record, merchant: 'Target' });
    const itemWrites = [];
    receipt.items = receipt.items.map((item) => {
      const itemId = canonicalItemId(phone, 'target', item);
      itemWrites.push(db.collection('items').doc(itemId).set({
        ...item,
        id: itemId,
        merchant: 'Target',
        merchantKey: 'target',
        from: phone,
        ownerUid: uid,
        publicName: item.publicName || item.name,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }));
      return { ...item, itemId };
    });
    await Promise.all(itemWrites);

    const sourceFields = {
      source: 'target',
      sourceOrderId: String(record.sourceOrderId),
      sourceOrderType: record.sourceOrderType === 'in-store' ? 'in-store' : 'online',
      sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : null,
      sourceInvoiceUrl: typeof record.sourceInvoiceUrl === 'string' ? record.sourceInvoiceUrl : null,
      audited: record.audited === true,
      auditStatus: record.audited === true ? 'audited' : 'needs_review',
      sourceSubtotal: Number.isFinite(Number(record.sourceSubtotal)) ? Number(record.sourceSubtotal) : null,
      sourceTax: Number.isFinite(Number(record.sourceTax)) ? Number(record.sourceTax) : null,
      sourceDiscountTotal: Number.isFinite(Number(record.sourceDiscountTotal)) ? Number(record.sourceDiscountTotal) : null,
      sourceTotal: Number.isFinite(Number(record.sourceTotal)) ? Number(record.sourceTotal) : null,
      auditLineItemsTotal: receipt.items.reduce((sum, item) => sum + (item.lineTotal ?? item.price ?? 0), 0),
    };
    if (!existing.empty) {
      await existing.docs[0].ref.set({ ...receipt, ...sourceFields, merchantKey: 'target', editedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      skipped.push({ sourceOrderId: String(record.sourceOrderId), id: existing.docs[0].id, updated: true });
      continue;
    }

    const legacy = receipt.date && receipt.total != null
      ? await db.collection('receipts').where('from', '==', phone).where('merchantKey', '==', 'target').where('date', '==', receipt.date).where('total', '==', receipt.total).limit(1).get()
      : { empty: true };
    if (!legacy.empty) {
      await legacy.docs[0].ref.set({ ...sourceFields, ...receipt, merchantKey: 'target', editedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      skipped.push({ sourceOrderId: String(record.sourceOrderId), id: legacy.docs[0].id, updated: true });
      continue;
    }

    const ref = db.collection('receipts').doc();
    await ref.set({ ...receipt, ...sourceFields, merchantKey: 'target', from: phone, ownerUid: uid, messageSid: null, imagePaths: [], createdAt: admin.firestore.FieldValue.serverTimestamp() });
    imported.push({ sourceOrderId: String(record.sourceOrderId), id: ref.id });
  }
  return { imported, skipped };
}

async function listItems(request) {
  const { phone } = requireAuth(request);
  const snapshot = await admin.firestore().collection('items').where('from', '==', phone).limit(100).get();
  const items = snapshot.docs.map(serializeDoc);
  items.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
  return { items };
}

async function updateItem(request) {
  const { phone } = requireAuth(request);
  const id = String(request.data?.id || '').trim();
  if (!id) throw new Error('Item id is required');
  const ref = admin.firestore().collection('items').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.get('from') !== phone) {
    const error = new Error('Item not found');
    error.code = 'not-found';
    throw error;
  }
  const patch = request.data?.patch || {};
  const allowed = ['publicName', 'name', 'itemNumber', 'upc', 'dpci', 'productUrl', 'category', 'verified'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
  if (typeof clean.publicName === 'string') clean.publicName = clean.publicName.trim();
  if (typeof clean.name === 'string') clean.name = clean.name.trim();
  if (typeof clean.itemNumber === 'string') clean.itemNumber = clean.itemNumber.trim();
  if (typeof clean.upc === 'string') clean.upc = clean.upc.trim();
  if (typeof clean.dpci === 'string') clean.dpci = clean.dpci.trim();
  if (typeof clean.productUrl === 'string') clean.productUrl = clean.productUrl.trim();
  await ref.set({ ...clean, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { id, ...snapshot.data(), ...clean };
}

module.exports = {
  EDITABLE_FIELDS,
  VISIBLE_FAILURE_STATUSES,
  requireAuth,
  cleanPatch,
  listReceipts,
  getReceipt,
  updateReceipt,
  getReceiptImageUrls,
  listProcessingFailures,
  getProcessingFailureImageUrls,
  retryProcessing,
  importTargetReceipts,
  listItems,
  updateItem,
};
