const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

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
  const serviceAccountPath = resolveServiceAccountPath();
  if (serviceAccountPath) {
    const credential = admin.credential.cert(require(serviceAccountPath));
    admin.initializeApp({ credential });
    return { admin, credentialSource: serviceAccountPath };
  }

  admin.initializeApp();
  return { admin, credentialSource: 'application-default-credentials' };
}

module.exports = { initializeAdminApp, resolveServiceAccountPath };
