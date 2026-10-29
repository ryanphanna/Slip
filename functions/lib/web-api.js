const admin = require('firebase-admin');
const crypto = require('node:crypto');
const { validateReceipt, dateLooksWrong, totalsLookWrong, itemsLookMissing, normalizeEditPatch, normalizeItemPatch } = require('./validate');
const { parseReceiptFromBase64, parseReceiptFromText } = require('./receipt');
const { getSettings, updateSettings, settingsId } = require('./settings');
const config = require('./config');
const { isAllowed } = require('./allowlist');
const importTokens = require('./import-tokens');
const { monthStatsFromDocs, loadAllReceipts, isMonthKey, shiftMonthKey } = require('./query');
const { DEFAULT_CURRENCY, currencyOf } = require('./money');

const EDITABLE_FIELDS = new Set([
  'merchant', 'location', 'date', 'total', 'subtotal', 'tax', 'category',
  'subCategory', 'currency', 'type', 'isSubscription', 'loyaltyPointsEarned',
  'loyaltyPointsBalance', 'items',
]);
const VISIBLE_FAILURE_STATUSES = new Set(['failed', 'pending', '', 'resolved', 'duplicate', 'retrying']);

function requireAuth(request) {
  if (!request.auth?.uid || !request.auth.token?.phone_number) {
    const error = new Error('Authentication required');
    error.code = 'unauthenticated';
    throw error;
  }
  // Same ALLOWED_PHONES list the SMS path uses; fails closed if unset.
  if (!isAllowed(request.auth.token.phone_number)) {
    const error = new Error('This account is not enabled for Slip');
    error.code = 'permission-denied';
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
  let query = receiptQuery(db, uid, phone);
  if (options.cursor) query = query.startAfter(admin.firestore.Timestamp.fromMillis(Number(options.cursor)));
  query = query.limit(limit + 1);

  if (options.category) query = query.where('category', '==', String(options.category));
  if (options.merchant) query = query.where('merchantKey', '==', String(options.merchant).trim().toLowerCase());
  if (options.startDate) query = query.where('date', '>=', String(options.startDate));
  if (options.endDate) query = query.where('date', '<=', String(options.endDate));

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);
  const lastCreatedAt = docs.at(-1)?.get('createdAt');
  return {
    receipts: docs.map(serializeDoc),
    hasMore: snapshot.docs.length > limit,
    nextCursor: lastCreatedAt?.toMillis?.() || null,
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

  const patch = normalizeEditPatch(cleanPatch(request.data?.patch));
  const next = validateReceipt({ ...snapshot.data(), ...patch });
  // Recompute on every edit so the search/duplicate key always follows the merchant.
  next.merchantKey = next.merchant ? next.merchant.trim().toLowerCase() : null;
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
      && ((Array.isArray(failure.imagePaths) && failure.imagePaths.length > 0)
        || (typeof failure.sourceText === 'string' && failure.sourceText.trim().length > 0)))
    // The pasted text stays server-side; the list only says a text retry is possible.
    .map(({ sourceText, ...rest }) => (sourceText ? { ...rest, hasSourceText: true } : rest));
  failures.sort((a, b) => {
    const aTime = a.createdAt?.toMillis?.() || 0;
    const bTime = b.createdAt?.toMillis?.() || 0;
    return bTime - aTime;
  });
  return { failures };
}

async function listNotifications(request) {
  const { phone } = requireAuth(request);
  const snapshot = await admin.firestore().collection('notifications')
    .where('from', '==', phone)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  return { notifications: snapshot.docs.map(serializeDoc) };
}

const TOP_MERCHANT_LIMIT = 5;

// Where the most CAD went: same `total` field and CAD-only rule as the
// recap total, so the list is always a subset of the headline number.
function topMerchants(docs) {
  const byKey = new Map();
  for (const doc of docs) {
    if (doc.total == null || currencyOf(doc) !== DEFAULT_CURRENCY) continue;
    const name = (doc.merchant || '').trim() || 'Unknown merchant';
    const key = name.toLowerCase();
    const entry = byKey.get(key) || { name, total: 0, count: 0 };
    // Same store typed in different case: prefer a capitalized spelling.
    if (entry.name === entry.name.toLowerCase() && name !== name.toLowerCase()) entry.name = name;
    entry.total += doc.total;
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((entry) => ({ ...entry, total: Math.round(entry.total * 100) / 100 }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, TOP_MERCHANT_LIMIT);
}

// One month's recap for the web recap page (CIV-1073). Uses the same month
// filter and aggregation as the monthly recap SMS / Notifications card.
async function getMonthlyRecap(request) {
  const { phone } = requireAuth(request);
  const monthKey = request.data?.month;
  if (!isMonthKey(monthKey)) {
    const error = new Error('Month must look like 2026-09');
    error.code = 'invalid-argument';
    throw error;
  }
  const snapshots = await loadAllReceipts(phone);
  const all = snapshots.map((doc) => ({ id: doc.id, ...doc.data() }));
  const { docs, ...current } = monthStatsFromDocs(all, monthKey);
  const { docs: _previousDocs, ...previous } = monthStatsFromDocs(all, shiftMonthKey(monthKey, -1));
  // Full receipt documents, the same shape listReceipts returns, because the
  // receipt detail panel edits and saves whatever it is given.
  const receipts = docs.sort((a, b) => (b.date || '').localeCompare(a.date || '')
    || (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  return {
    ...current,
    year: Number(monthKey.slice(0, 4)),
    previous: { ...previous, year: Number(previous.monthKey.slice(0, 4)) },
    topMerchants: topMerchants(docs),
    receipts,
  };
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

const RETRY_CLAIM_STALE_MS = 3 * 60 * 1000;

function retryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Atomically claims a failure for retry: rejects already-recovered or
// in-flight failures and enforces the per-account hourly retry limit, so
// repeated or concurrent calls cannot trigger extra Gemini calls.
async function claimRetry(db, failureRef, phone) {
  const limitRef = db.collection('retry_limits').doc(settingsId(phone));
  return db.runTransaction(async (tx) => {
    const failure = await tx.get(failureRef);
    if (!failure.exists || failure.get('from') !== phone) throw retryError('not-found', 'Processing failure not found');
    const status = failure.get('status');
    if (status === 'recovered') throw retryError('failed-precondition', 'This receipt was already recovered');
    if (status === 'resolved') throw retryError('failed-precondition', 'This item was already resolved');
    const startedAt = failure.get('retryStartedAt')?.toMillis?.() || 0;
    if (status === 'retrying' && Date.now() - startedAt < RETRY_CLAIM_STALE_MS) {
      throw retryError('failed-precondition', 'A retry for this receipt is already in progress');
    }
    const paths = failure.get('imagePaths') || [];
    const sourceText = typeof failure.get('sourceText') === 'string' ? failure.get('sourceText').trim() : '';
    if (paths.length === 0 && !sourceText) throw new Error('This failure has no stored image or text to retry');

    const limit = await tx.get(limitRef);
    const windowStart = limit.exists ? limit.get('windowStart') || 0 : 0;
    const inWindow = Date.now() - windowStart < config.RETRY_RATE_LIMIT_WINDOW_MS;
    const count = inWindow && limit.exists ? limit.get('count') || 0 : 0;
    if (count >= config.RETRY_RATE_LIMIT_PER_HOUR) {
      throw retryError('resource-exhausted', 'Too many retries. Try again later.');
    }
    const claimWindowStart = inWindow && limit.exists ? windowStart : Date.now();
    tx.set(limitRef, { from: phone, windowStart: claimWindowStart, count: count + 1 });

    const previousStatus = status === 'retrying' ? (failure.get('previousStatus') ?? 'failed') : (status ?? 'failed');
    const token = crypto.randomUUID();
    tx.set(failureRef, {
      status: 'retrying',
      // A stale takeover keeps the original pre-retry status, never 'retrying'.
      previousStatus,
      retryToken: token,
      retryWindowStart: claimWindowStart,
      retryStartedAt: admin.firestore.Timestamp.fromMillis(Date.now()),
    }, { merge: true });
    return {
      paths,
      sourceText,
      token,
      messageSid: failure.get('messageSid') || null,
      previousStatus,
      receivedAt: failure.get('createdAt')?.toDate?.() || new Date(),
      limitRef,
      windowStart: claimWindowStart,
    };
  });
}

async function retryProcessing(request) {
  const { phone } = requireAuth(request);
  const id = String(request.data?.id || '');
  if (!id) throw retryError('invalid-argument', 'Failure id is required');
  const db = admin.firestore();
  const failureRef = db.collection('processing_failures').doc(id);
  const { paths, sourceText, token, messageSid, previousStatus, receivedAt, limitRef, windowStart } = await claimRetry(db, failureRef, phone);

  // Only the claim's owner may release it, and only while it is still held;
  // a superseded or finished claim is never overwritten. `refund` returns the
  // rate-limit slot when no Gemini result was obtained.
  const release = ({ refund, status, extra = {} }) => db.runTransaction(async (tx) => {
    const current = await tx.get(failureRef);
    if (current.get('status') !== 'retrying' || current.get('retryToken') !== token) return;
    if (refund) {
      const limit = await tx.get(limitRef);
      if (limit.exists && limit.get('windowStart') === windowStart && (limit.get('count') || 0) > 0) {
        tx.set(limitRef, { count: limit.get('count') - 1 }, { merge: true });
      }
    }
    tx.set(failureRef, {
      status: status || previousStatus,
      retryToken: null,
      ...extra,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }).catch(() => {});

  // Same rule as the SMS path: an account's very first receipt is parsed on the Pro model.
  let isFirstReceipt = false;
  try {
    const existing = await db.collection('receipts').where('from', '==', phone).limit(1).get();
    isFirstReceipt = existing.empty;
  } catch (_) {
    // Not critical; fall back to the default model.
  }

  let receipt;
  try {
    let raw;
    if (paths.length > 0) {
      const bucket = admin.storage().bucket();
      const images = await Promise.all(paths.map(async (path) => {
        const file = bucket.file(path);
        const [buffer] = await file.download();
        const [metadata] = await file.getMetadata();
        return { base64: buffer.toString('base64'), mimeType: metadata.contentType || 'image/jpeg' };
      }));
      raw = await parseReceiptFromBase64(images, undefined, isFirstReceipt);
    } else {
      // Text-only failure: re-parse the pasted text through the same text path SMS uses.
      raw = await parseReceiptFromText(sourceText, isFirstReceipt);
      const extractedNothing = raw.merchant == null && raw.total == null
        && (!Array.isArray(raw.items) || raw.items.length === 0);
      if (extractedNothing) throw retryError('not-a-receipt', "That text didn't look like a receipt");
    }
    receipt = validateReceipt(raw);
    if (raw.confidence != null) receipt.confidence = raw.confidence;
    if (receipt.date == null || dateLooksWrong(receipt.date, receivedAt)) receipt.dateNeedsCheck = true;
    if (totalsLookWrong(receipt)) receipt.totalsNeedCheck = true;
    if (paths.length > 0 && itemsLookMissing(receipt)) receipt.itemsNeedCheck = true;
  } catch (error) {
    if (error.code === 'not-a-receipt') {
      // The text was read fine but is not a receipt: retrying can never help, so
      // close the failure instead of leaving it retryable. The Gemini call was
      // made, so the rate-limit slot stays used.
      await release({ refund: false, status: 'resolved', extra: { resolution: 'not-a-receipt' } });
      throw retryError('failed-precondition', error.message);
    }
    await release({ refund: true });
    throw error;
  }

  const receiptRef = db.collection('receipts').doc();
  try {
    await db.runTransaction(async (tx) => {
      const current = await tx.get(failureRef);
      if (current.get('status') !== 'retrying' || current.get('retryToken') !== token) {
        throw retryError('failed-precondition', 'This retry was superseded');
      }
      tx.set(receiptRef, {
        ...receipt,
        merchantKey: receipt.merchant ? receipt.merchant.trim().toLowerCase() : null,
        from: phone,
        ownerUid: request.auth.uid,
        messageSid,
        imagePaths: paths,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        recoveredFromFailure: id,
      });
      tx.set(failureRef, {
        status: 'recovered',
        recoveredReceiptId: receiptRef.id,
        retryToken: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  } catch (error) {
    if (error.code !== 'failed-precondition') await release({ refund: false });
    throw error;
  }
  return { id: receiptRef.id, ...receipt };
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
        // The receipt's currency, so the web app can show an item's price
        // without loading its receipt (CIV-434).
        currency: receipt.currency,
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
      // Saved as CAD when no currency was sent; flag it like an AI import (CIV-434).
      currencyNeedsCheck: record.currency === undefined ? true : admin.firestore.FieldValue.delete(),
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
    if (record.currency !== undefined) delete sourceFields.currencyNeedsCheck;
    await ref.set({ ...receipt, ...sourceFields, merchantKey: 'target', from: phone, ownerUid: uid, messageSid: null, imagePaths: [], createdAt: admin.firestore.FieldValue.serverTimestamp() });
    imported.push({ sourceOrderId: String(record.sourceOrderId), id: ref.id });
  }
  return { imported, skipped };
}

async function listItems(request) {
  const { phone } = requireAuth(request);
  const snapshot = await admin.firestore().collection('items').where('from', '==', phone).limit(500).get();
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
  const clean = normalizeItemPatch(request.data?.patch);
  await ref.set({ ...clean, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { id, ...snapshot.data(), ...clean };
}

async function getUserSettings(request) {
  const { phone } = requireAuth(request);
  return getSettings(phone);
}

async function updateUserSettings(request) {
  const { phone } = requireAuth(request);
  return updateSettings(phone, request.data?.patch);
}

async function createImportToken(request) {
  const { uid, phone } = requireAuth(request);
  return importTokens.createToken({ from: phone, uid, label: request.data?.label });
}

async function listImportTokens(request) {
  const { phone } = requireAuth(request);
  return { tokens: await importTokens.listTokens(phone) };
}

async function revokeImportToken(request) {
  const { phone } = requireAuth(request);
  return importTokens.revokeToken(phone, request.data?.id);
}

module.exports = {
  createImportToken,
  listImportTokens,
  revokeImportToken,
  EDITABLE_FIELDS,
  VISIBLE_FAILURE_STATUSES,
  requireAuth,
  cleanPatch,
  listReceipts,
  getReceipt,
  updateReceipt,
  getReceiptImageUrls,
  listProcessingFailures,
  listNotifications,
  getMonthlyRecap,
  getProcessingFailureImageUrls,
  retryProcessing,
  importTargetReceipts,
  listItems,
  updateItem,
  getUserSettings,
  updateUserSettings,
};
