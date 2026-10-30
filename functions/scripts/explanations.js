#!/usr/bin/env node
/**
 * Flagged receipts with an explanation left in the web app ("Explain this
 * charge"), for the next processing pass to act on (CIV-1186). Reads only.
 *
 * Usage:
 *   node scripts/explanations.js --phone +14165551234
 */
const { initializeAdminApp } = require('../lib/admin');
const { CHECK_FIELDS, isFlagged } = require('../lib/receipt-checks');

const args = process.argv.slice(2);
const phone = args.includes('--phone') ? args[args.indexOf('--phone') + 1] : null;

if (!phone || !/^\+\d{10,15}$/.test(phone)) {
  console.error('Usage: node scripts/explanations.js --phone +14165551234');
  process.exit(1);
}

// The marks set on a receipt, with the card charge for a statement mark.
function marks(receipt) {
  return CHECK_FIELDS.filter((field) => receipt[field] && field !== 'possibleDuplicateOf').map((field) => {
    if (field === 'possibleDuplicate') return `possibleDuplicate of ${receipt.possibleDuplicateOf || '?'}`;
    if (field === 'checkNote') return `checkNote: ${receipt.checkNote}`;
    if (field === 'statementReview') {
      const { reason, charge } = receipt.statementReview;
      const c = charge ? ` (charge ${charge.date} ${charge.amount} ${charge.description} on ${charge.account})` : '';
      return `statementReview: ${reason || ''}${c}`;
    }
    return field;
  });
}

async function main() {
  initializeAdminApp();
  const admin = require('firebase-admin');
  const snap = await admin.firestore().collection('receipts').where('from', '==', phone).get();
  const explained = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((r) => isFlagged(r) && r.explanation?.text)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  console.log(`${explained.length} flagged receipt(s) with an explanation.`);
  for (const r of explained) {
    console.log(`\n${r.id}  ${r.date || 'no date'}  ${r.merchant}  ${r.total} ${r.currency || 'CAD'}`);
    marks(r).forEach((mark) => console.log(`  mark: ${mark}`));
    console.log(`  explanation: ${r.explanation.text}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
