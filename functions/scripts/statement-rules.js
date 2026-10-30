#!/usr/bin/env node
/**
 * Statement import rules for one account (CIV-1186), kept in the
 * statement_rules collection. upload-statements.js applies them before its
 * own rules: the first rule that fits a charge sets its bucket, store name or
 * category. A rule:
 *   { pattern (case-insensitive regex text tested against the description),
 *     minAmount?, maxAmount?, merchant?, category?, subCategory?, bucket? }
 * Amounts compare against the charge's amount either way (a refund too).
 * Adding the same rule twice keeps one copy.
 *
 * Usage:
 *   node scripts/statement-rules.js --phone +14165551234 --list
 *   node scripts/statement-rules.js --phone +14165551234 --add '{"pattern":"GOODLIFE","bucket":"bills"}'
 *   node scripts/statement-rules.js --phone +14165551234 --seed     (adds statement-rules.seed.json)
 */
const crypto = require('crypto');
const path = require('path');
const { initializeAdminApp } = require('../lib/admin');
const { ruleProblems } = require('../lib/statement-import');
const { canonical } = require('../lib/import-receipt');

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const phone = option('--phone');
const add = option('--add');
const seed = args.includes('--seed');

if (!phone || !/^\+\d{10,15}$/.test(phone) || (!add && !seed && !args.includes('--list'))) {
  console.error('Usage: node scripts/statement-rules.js --phone +14165551234 [--list] [--add \'{json}\'] [--seed]');
  process.exit(1);
}

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
// The same rule for the same account always gets the same id.
const ruleId = (rule) => sha(`${phone}|${canonical(rule)}`).slice(0, 20);
const show = ({ from, createdAt, ...rule }) => JSON.stringify(rule);

async function main() {
  let toAdd = [];
  if (add) {
    try {
      toAdd.push(JSON.parse(add));
    } catch {
      console.error('--add needs a JSON rule');
      process.exit(1);
    }
  }
  if (seed) toAdd = toAdd.concat(require(path.join(__dirname, 'statement-rules.seed.json')));
  for (const rule of toAdd) {
    const problems = ruleProblems(rule);
    if (problems.length) {
      console.error(`Rule not added: ${JSON.stringify(rule)}: ${problems.join('; ')}`);
      process.exit(1);
    }
  }

  initializeAdminApp();
  const admin = require('firebase-admin');
  const rules = admin.firestore().collection('statement_rules');
  for (const rule of toAdd) {
    const ref = rules.doc(ruleId(rule));
    if ((await ref.get()).exists) {
      console.log(`Already there: ${JSON.stringify(rule)}`);
      continue;
    }
    await ref.create({ ...rule, from: phone, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`Added: ${JSON.stringify(rule)}`);
  }

  const snap = await rules.where('from', '==', phone).get();
  console.log(`${snap.size} rule(s), in the order they apply:`);
  sortRules(snap.docs).forEach((doc) => console.log(`  ${doc.id} ${show(doc.data())}`));
}

// Oldest first, as upload-statements.js applies them.
function sortRules(docs) {
  const time = (doc) => doc.get('createdAt')?.toMillis?.() || 0;
  return [...docs].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
