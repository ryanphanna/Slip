const admin = require('firebase-admin');
const crypto = require('node:crypto');

const TOKEN_PREFIX = 'slip_pat_';
const SCOPE = 'receipts:write';
const LAST_USED_THROTTLE_MS = 60 * 1000;
const MAX_ACTIVE_TOKENS = 10;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicId(hash) {
  return hash.slice(0, 16);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Only the SHA-256 hash is stored (doc id). The raw token is returned once.
async function createToken({ from, uid, label }) {
  const clean = typeof label === 'string' ? label.trim().slice(0, 60) : '';
  const db = admin.firestore();
  const existing = await db.collection('import_tokens').where('from', '==', from).get();
  if (existing.docs.filter((d) => !d.get('revokedAt')).length >= MAX_ACTIVE_TOKENS) {
    throw fail('invalid-argument', `You can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`);
  }
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const hash = hashToken(token);
  await db.collection('import_tokens').doc(hash).set({
    from,
    uid,
    label: clean || 'AI assistant',
    scope: SCOPE,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastUsedAt: null,
    revokedAt: null,
  });
  return { token, id: publicId(hash), label: clean || 'AI assistant' };
}

async function listTokens(from) {
  const snapshot = await admin.firestore().collection('import_tokens').where('from', '==', from).get();
  return snapshot.docs
    .map((doc) => ({
      id: publicId(doc.id),
      label: doc.get('label'),
      createdAt: doc.get('createdAt')?.toMillis?.() || null,
      lastUsedAt: doc.get('lastUsedAt')?.toMillis?.() || null,
      revoked: Boolean(doc.get('revokedAt')),
    }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function revokeToken(from, id) {
  const snapshot = await admin.firestore().collection('import_tokens').where('from', '==', from).get();
  const match = snapshot.docs.find((doc) => publicId(doc.id) === String(id));
  if (!match) throw fail('not-found', 'Token not found');
  await match.ref.set({ revokedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { id: String(id), revoked: true };
}

// Resolves a raw bearer token to its account. Returns null for anything
// unknown or revoked; never reveals which.
async function authenticateToken(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken.startsWith(TOKEN_PREFIX) || rawToken.length > 200) return null;
  const hash = hashToken(rawToken);
  const ref = admin.firestore().collection('import_tokens').doc(hash);
  const doc = await ref.get();
  if (!doc.exists || doc.get('revokedAt') || doc.get('scope') !== SCOPE) return null;

  const lastUsed = doc.get('lastUsedAt')?.toMillis?.() || 0;
  if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
    await ref.set({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
  }
  return { tokenId: publicId(hash), from: doc.get('from'), uid: doc.get('uid'), scope: SCOPE };
}

module.exports = { TOKEN_PREFIX, SCOPE, MAX_ACTIVE_TOKENS, hashToken, createToken, listTokens, revokeToken, authenticateToken };
