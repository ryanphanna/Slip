#!/usr/bin/env node
// Apply GCS lifecycle rules to auto-delete receipts-temporary/ objects after 30 days.
// Run once (or re-run to update): node scripts/setup-lifecycle.js

const { initializeAdminApp } = require('../lib/admin');
const admin = require('firebase-admin');

initializeAdminApp();

const RETENTION_DAYS = 30;
const TEMP_PREFIX = 'receipts-temporary/';

async function main() {
  const bucket = admin.storage().bucket();

  await bucket.setMetadata({
    lifecycle: {
      rule: [
        {
          action: { type: 'Delete' },
          condition: {
            age: RETENTION_DAYS,
            matchesPrefix: [TEMP_PREFIX],
          },
        },
      ],
    },
  });

  console.log(`Lifecycle rule set: objects under ${TEMP_PREFIX} will be deleted after ${RETENTION_DAYS} days.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
