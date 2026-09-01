const admin = require('firebase-admin');

const DEFAULT_SETTINGS = { monthlyDigestEnabled: true };

function settingsId(phone) {
  return String(phone || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
}

async function getSettings(phone) {
  const doc = await admin.firestore().collection('settings').doc(settingsId(phone)).get();
  return { ...DEFAULT_SETTINGS, ...(doc.exists ? doc.data() : {}) };
}

async function updateSettings(phone, patch) {
  if (typeof patch?.monthlyDigestEnabled !== 'boolean') {
    const error = new Error('monthlyDigestEnabled must be a boolean');
    error.code = 'invalid-argument';
    throw error;
  }
  const settings = { monthlyDigestEnabled: patch.monthlyDigestEnabled };
  await admin.firestore().collection('settings').doc(settingsId(phone)).set({
    ...settings,
    from: phone,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return settings;
}

module.exports = { DEFAULT_SETTINGS, settingsId, getSettings, updateSettings };
