#!/usr/bin/env node
/**
 * Read bank and card statements into plain transactions (CIV-1186). Reading
 * and cleaning only: nothing is written to Firestore. Writes two JSON files
 * to the --out folder, which must be outside the repo:
 *   transactions.json      every reconciled, deduplicated transaction
 *   gap-transactions.json  only the months the Notion ledger lacks
 *   report.json            inventory, reconciliation, gaps, overlaps and totals
 *
 * Files are named in the output by account label and month, never by their
 * file name, since statement file names often carry account digits. CSVs
 * name no account, so --accounts gives a JSON file (kept outside the repo)
 * of file-name prefix -> label.
 *
 * Usage:
 *   node scripts/read-statements.js <folder> [more folders] --out <folder> [--accounts accounts.json]
 */
const fs = require('fs');
const path = require('path');
const { listFiles, readStatementFiles, monthsBetween, monthOf } = require('../lib/statement-files');

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const outDir = option('--out');
const accountsFile = option('--accounts');
const folders = args.filter((arg, index) => !arg.startsWith('--') && !['--out', '--accounts'].includes(args[index - 1]));

if (!outDir || folders.length === 0) {
  console.error('Usage: node scripts/read-statements.js <folder> [more] --out <folder> [--accounts accounts.json]');
  process.exit(1);
}
if (path.resolve(outDir).startsWith(path.resolve(__dirname, '..', '..'))) {
  console.error('--out must be outside the repo');
  process.exit(1);
}

// Date ranges (inclusive) that Ryan's Notion ledger does not cover, per
// account. gap-transactions.json holds only these.
const NOTION_GAPS = {
  'Amex Cobalt': [[null, '2023-07-31']],
  'Amex Marriott': [[null, '2023-07-31']],
  'Amex SimplyCash Preferred': [[null, '2025-11-30']],
  'Simplii Cash Back Visa': [[null, '2023-12-31']],
  'Simplii chequing': [['2023-03-01', '2025-11-30']],
};
const inGap = (t) => (NOTION_GAPS[t.account] || []).some(([from, to]) => (!from || t.date >= from) && (!to || t.date <= to));

const accounts = accountsFile ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : {};
const cents = (n) => Math.round(n * 100) / 100;

function main() {
  const files = folders.flatMap((folder) => listFiles(folder));
  const { inventory, uniqueSources, duplicateFiles, transactions, dropped } = readStatementFiles(files, { accounts });

  // Label files whose content could not be read from their readable siblings.
  const labelled = inventory.filter((e) => e.account);
  for (const entry of inventory.filter((e) => !e.account)) {
    const sibling = labelled.find((e) => e.folder === entry.folder);
    if (/PC Financial/i.test(entry.folder)) entry.account = 'PC Financial';
    else if (sibling) entry.account = sibling.account;
    entry.labelFrom = 'folder';
  }

  // Same account and month from two different files (CSV and PDF, or two
  // copies of one month that are not byte-identical).
  const monthFiles = new Map();
  for (const s of uniqueSources) {
    const key = `${s.account}|${s.month}`;
    monthFiles.set(key, [...(monthFiles.get(key) || []), s.kind]);
  }
  const overlaps = [...monthFiles].filter(([, kinds]) => kinds.length > 1).map(([key, kinds]) => ({ account: key.split('|')[0], month: key.split('|')[1], sources: kinds }));

  const gapTransactions = transactions.filter(inGap);

  // Coverage per account: the statement months present, and missing months
  // between the first and last.
  const coverage = {};
  for (const entry of inventory) {
    const account = entry.account || 'unknown';
    const c = coverage[account] = coverage[account] || { files: 0, formats: {}, months: new Set(), notDownloaded: [], from: null, to: null };
    c.files += 1;
    c.formats[entry.format] = (c.formats[entry.format] || 0) + 1;
    const month = entry.month || (entry.period && monthOf(entry.period.to));
    if (month) c.months.add(month);
    if (entry.monthHint) c.notDownloaded.push(entry.monthHint);
    const range = entry.dateRange || entry.period;
    if (range) {
      if (!c.from || range.from < c.from) c.from = range.from;
      if (!c.to || range.to > c.to) c.to = range.to;
    }
  }
  for (const c of Object.values(coverage)) {
    const months = [...c.months].sort();
    c.statementMonths = months.length ? `${months[0]} to ${months[months.length - 1]}` : null;
    c.missingMonths = months.length ? monthsBetween(months[0], months[months.length - 1]).filter((m) => !c.months.has(m) && !c.notDownloaded.includes(m)) : [];
    delete c.months;
  }

  // Totals by kind, account and year.
  const totals = {};
  for (const t of transactions) {
    const key = `${t.account}|${t.date.slice(0, 4)}|${t.kind}`;
    const row = totals[key] = totals[key] || { account: t.account, year: t.date.slice(0, 4), kind: t.kind, count: 0, amount: 0 };
    row.count += 1;
    row.amount = cents(row.amount + t.amount);
  }

  const failed = inventory.filter((e) => e.reconciliation && !e.reconciliation.ok)
    .map((e) => ({ account: e.account, month: e.month, problems: e.reconciliation.problems }));
  const report = {
    generatedAt: new Date().toISOString(),
    folders: folders.map((f) => path.resolve(f.replace(/^~/, process.env.HOME))),
    files: inventory.length,
    inventory,
    coverage,
    duplicateFiles,
    overlaps,
    reconciliation: {
      passed: inventory.filter((e) => e.reconciliation && e.reconciliation.ok).length,
      failed,
    },
    dedupe: dropped,
    transactions: transactions.length,
    gapTransactions: gapTransactions.length,
    notionGaps: NOTION_GAPS,
    totals: Object.values(totals).sort((a, b) => a.account.localeCompare(b.account) || a.year.localeCompare(b.year) || a.kind.localeCompare(b.kind)),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'transactions.json'), `${JSON.stringify(transactions, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'gap-transactions.json'), `${JSON.stringify(gapTransactions, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${inventory.length} files, ${report.reconciliation.passed} statements reconciled, ${failed.length} failed, ${transactions.length} transactions`);
  console.log(`Wrote ${path.join(outDir, 'transactions.json')} and report.json`);
}

main();
