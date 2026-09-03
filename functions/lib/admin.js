const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Polyfill firebase-admin v14 top-level service getters for compatibility
if (!admin.firestore) {
  const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
  admin.firestore = getFirestore;
  admin.firestore.FieldValue = FieldValue;
  admin.firestore.Timestamp = Timestamp;
}
if (!admin.storage) {
  const { getStorage } = require('firebase-admin/storage');
  admin.storage = getStorage;
}


function resolveServiceAccountPath() {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    path.join(__dirname, '..', 'serviceAccountKey.json'),
    path.join(__dirname, '..', '..', 'serviceAccountKey.json'),
    path.join(__dirname, '..', '..', '..', '..', '..', 'Credentials', 'Firebase for Slip.json'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function initializeAdminApp() {
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || 'slip-c742b.firebasestorage.app';
  const serviceAccountPath = resolveServiceAccountPath();
  if (serviceAccountPath) {
    const credential = admin.cert(require(serviceAccountPath));
    admin.initializeApp({ credential, storageBucket });

    return { admin, credentialSource: serviceAccountPath };
  }

  admin.initializeApp({ storageBucket });
  return { admin, credentialSource: 'application-default-credentials' };
}

module.exports = { initializeAdminApp, resolveServiceAccountPath };
