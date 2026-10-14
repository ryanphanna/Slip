const admin = require('firebase-admin');
const crypto = require('node:crypto');
const config = require('./config');
const { validateReceipt } = require('./validate');
const { saveReceipt, findDuplicate, checkRateLimit } = require('./store');
const { validateImport, SCHEMA_VERSION } = require('./import-schema');
const { formatMoney, currencyOf } = require('./money');

const CLAIM_STALE_MS = 2 * 60 * 1000;

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

// Stable hash of the submitted payload (key order independent) so a reused
// idempotency key with different data is caught instead of silently ignored.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function checkTokenRateLimit(from, tokenId) {
  const oneHourAgo = new Date(Date.now() - config.RATE_LIMIT_WINDOW_MS);
  const snapshot = await admin.firestore().collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', oneHourAgo)
    .get();
  const count = snapshot.docs.filter((d) => d.get('importSource.tokenId') === tokenId).length;
  return count >= config.IMPORT_TOKEN_RATE_LIMIT_PER_HOUR;
}

// `identity` comes only from the authenticated token ({ from, uid, tokenId }).
async function importReceipt(identity, args) {
  const { errors, warnings } = validateImport(args);
  if (errors.length) throw fail('invalid-argument', 'Receipt rejected: ' + errors.join('; '), errors);

  const { from, tokenId } = identity;
  const db = admin.firestore();
  const claimRef = db.collection('import_idempotency').doc(`${sha(from).slice(0, 24)}_${sha(args.idempotencyKey)}`);
  const payloadHash = sha(canonical({ ...args, idempotencyKey: undefined }));

  // Claim the idempotency key. A claim with no receipt yet that is older than
  // CLAIM_STALE_MS belongs to a crashed call and may be taken over.
  let claimed = false;
  for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
    const existing = await claimRef.get();
    if (existing.exists) {
      const createdAt = existing.get('createdAt')?.toMillis?.() || 0;
      const abandoned = !existing.get('receiptId') && Date.now() - createdAt > CLAIM_STALE_MS;
      if (!abandoned) return replay(existing, payloadHash);
      await claimRef.delete().catch(() => {});
    }

    const limit = await checkRateLimit(from);
    if (limit.exceeded) throw fail('rate-limited', `Rate limit reached (${limit.reason}). Try again later.`);
    if (await checkTokenRateLimit(from, tokenId)) {
      throw fail('rate-limited', 'This token reached its hourly import limit. Try again later.');
    }

    try {
      await claimRef.create({ from, payloadHash, receiptId: null, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      claimed = true;
    } catch (err) {
      const raced = await claimRef.get();
      if (raced.exists) return replay(raced, payloadHash);
      throw err;
    }
  }
  if (!claimed) throw fail('conflict', 'An import with this idempotencyKey is still in progress. Retry shortly.');

  try {
    const receipt = validateReceipt(args);
    const duplicateId = await findDuplicate(receipt, from);
    if (duplicateId) {
      await claimRef.set({ receiptId: duplicateId, duplicate: true }, { merge: true });
      return { receiptId: duplicateId, duplicate: true, deduplicated: false, warnings, message: `Duplicate: ${receipt.merchant} was already logged.` };
    }
    const receiptId = await saveReceipt(receipt, from, null, [], {
      importSource: {
        client: args.source.client.trim(),
        ...(args.source.model ? { model: args.source.model.trim() } : {}),
        schemaVersion: SCHEMA_VERSION,
        tokenId,
        warnings,
      },
    });
    await claimRef.set({ receiptId, duplicate: false }, { merge: true });
    return { receiptId, duplicate: false, deduplicated: false, warnings, message: `Saved ${receipt.merchant}${receipt.total != null ? ` — ${formatMoney(Math.abs(receipt.total), currencyOf(receipt))}` : ''}.` };
  } catch (err) {
    // Release the claim so the caller can retry the same key.
    await claimRef.delete().catch(() => {});
    throw err;
  }
}

function replay(claimDoc, payloadHash) {
  if (claimDoc.get('payloadHash') !== payloadHash) {
    throw fail('invalid-argument', 'This idempotencyKey was already used with different receipt data. Use a new key.');
  }
  const receiptId = claimDoc.get('receiptId');
  if (!receiptId) throw fail('conflict', 'An import with this idempotencyKey is still in progress. Retry shortly.');
  return {
    receiptId,
    duplicate: Boolean(claimDoc.get('duplicate')),
    deduplicated: true,
    warnings: [],
    message: 'Already imported (same idempotencyKey); nothing new was saved.',
  };
}

module.exports = { importReceipt, canonical };
