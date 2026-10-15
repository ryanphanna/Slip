const admin = require('firebase-admin');
const config = require('./config');

const PURGEABLE_STATUSES = ['recovered', 'resolved', 'duplicate'];
const DAY_MS = 24 * 60 * 60 * 1000;

// Decides what to do with one stored image of a failure that is being purged.
// Returns 'delete', 'shared' (another receipt/failure still uses it) or 'skip'
// (outside the failed-image prefix, or we could not be sure).
async function classifyImage(db, path, failureId) {
  if (typeof path !== 'string' || !path.startsWith(`${config.STORAGE_PREFIX_FAILED}/`) || path.includes('..')) return 'skip';
  try {
    const receipt = await db.collection('receipts').where('imagePaths', 'array-contains', path).limit(1).get();
    if (!receipt.empty) return 'shared';
    const others = await db.collection('processing_failures').where('imagePaths', 'array-contains', path).limit(2).get();
    if (others.docs.some((d) => d.id !== failureId)) return 'shared';
    return 'delete';
  } catch (_) {
    return 'skip';
  }
}

// Deletes old, finished processing_failures (recovered / resolved / duplicate,
// last updated more than `retentionDays` ago) together with any stored image no
// receipt or other failure still references. failed / pending / retrying rows
// are never touched. Logs nothing itself; returns counts only.
async function purgeOldFailures({ dryRun = true, now = Date.now(), maxRows = 200, retentionDays = 90 } = {}) {
  const db = admin.firestore();
  const cutoff = new Date(now - retentionDays * DAY_MS);
  const counts = { dryRun, eligibleRows: 0, deletedRows: 0, deletedImages: 0, sharedImages: 0, skippedImages: 0, failedRows: 0 };

  const rows = [];
  for (const status of PURGEABLE_STATUSES) {
    if (rows.length >= maxRows) break;
    const snap = await db.collection('processing_failures')
      .where('status', '==', status)
      .where('updatedAt', '<=', cutoff)
      .orderBy('updatedAt', 'asc')
      .limit(maxRows - rows.length)
      .get();
    rows.push(...snap.docs);
  }
  counts.eligibleRows = rows.length;

  const bucket = rows.some((d) => (d.get('imagePaths') || []).length > 0) ? admin.storage().bucket() : null;
  for (const doc of rows) {
    // Re-check the guard fields on the document we are about to delete.
    if (!PURGEABLE_STATUSES.includes(doc.get('status'))) continue;
    try {
      const paths = Array.isArray(doc.get('imagePaths')) ? doc.get('imagePaths') : [];
      for (const path of paths) {
        const verdict = await classifyImage(db, path, doc.id);
        if (verdict === 'shared') counts.sharedImages += 1;
        else if (verdict === 'skip') counts.skippedImages += 1;
        else if (dryRun) counts.deletedImages += 1;
        else {
          await bucket.file(path).delete({ ignoreNotFound: true });
          counts.deletedImages += 1;
        }
      }
      if (!dryRun) await doc.ref.delete();
      counts.deletedRows += 1;
    } catch (_) {
      counts.failedRows += 1;
    }
  }
  return counts;
}

module.exports = { purgeOldFailures, PURGEABLE_STATUSES };
