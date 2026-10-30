#!/usr/bin/env node
/**
 * Read bank and card statements into plain transactions (CIV-1186). Reading
 * and cleaning only: nothing is written to Firestore. Writes two JSON files
 * to the --out folder, which must be outside the repo:
 *   transactions.json  every reconciled, deduplicated transaction
 *   report.json        inventory, reconciliation, gaps, overlaps and totals
 *
 * Files are named in the output by account label and month, never by their
 * file name, since statement file names often carry account digits. CSVs
 * name no account, so --accounts gives a JSON file (kept outside the repo)
 * of file-name prefix -> label.
 *
 * Usage:
 *   node scripts/read-statements.js <folder> [more folders] --out <folder> [--accounts accounts.json]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const statements = require('../lib/statements');

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

// Earlier outputs and folders that are not statements.
const SKIP_NAMES = [/^spending-v3-/, /^simplii-8956-review\.csv$/, /^\./];
const SKIP_FOLDERS = [/Simplii Court Case/i];

const accounts = accountsFile ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : {};

function listFiles(folder) {
  if (SKIP_FOLDERS.some((re) => re.test(folder))) return [];
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_NAMES.some((re) => re.test(entry.name))) return [];
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return /\.(pdf|csv)$/i.test(entry.name) ? [full] : [];
  }).sort();
}

// iCloud placeholders hang any read until downloaded, so they are listed only.
function notDownloaded(file) {
  try {
    return execFileSync('stat', ['-f', '%Sf', file], { encoding: 'utf8' }).includes('dataless');
  } catch {
    return false;
  }
}

function pdfText(file) {
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024 });
}

const monthOf = (date) => (date ? date.slice(0, 7) : null);
const cents = (n) => Math.round(n * 100) / 100;

function monthsBetween(first, last) {
  const months = [];
  let [year, month] = first.split('-').map(Number);
  const [endYear, endMonth] = last.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

function readFile(file) {
  const folder = path.dirname(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const entry = { folder, format: null, account: null, sha256: null, period: null, dateRange: null, parsed: false, note: null };
  if (notDownloaded(file)) {
    entry.format = `${ext} (not downloaded from iCloud)`;
    entry.monthHint = (path.basename(file).match(/^(\d{4})-(\d{2})\.pdf$/) || []).slice(1).join('-') || null;
    return { entry };
  }
  entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  if (ext === 'csv') {
    const prefix = Object.keys(accounts).find((key) => path.basename(file).startsWith(`${key} `));
    entry.format = 'amex-csv';
    entry.account = prefix ? accounts[prefix] : null;
    if (!entry.account) {
      entry.note = 'no label for this file in --accounts; not read';
      return { entry };
    }
    const transactions = statements.parseAmexCsv(fs.readFileSync(file, 'utf8'), { account: entry.account, sourceFile: null });
    return { entry, transactions, kind: 'csv' };
  }

  let text;
  try {
    text = pdfText(file);
  } catch (err) {
    entry.format = 'pdf (pdftotext failed)';
    entry.note = String(err.message).split('\n')[0];
    return { entry };
  }
  const described = statements.describeStatement(text);
  entry.format = described.format;
  entry.account = described.label;
  entry.period = described.period || null;
  if (described.noActivity) entry.note = 'no activity in this period';
  if (described.format === 'amex-pdf' || described.format === 'simplii-chequing-pdf') {
    const result = described.format === 'amex-pdf'
      ? statements.parseAmexPdf(text, { sourceFile: null })
      : statements.parseSimpliiChequingPdf(text, { sourceFile: null });
    entry.period = result.period;
    entry.reconciliation = result.reconciliation;
    return { entry, transactions: result.transactions, kind: 'pdf' };
  }
  if (described.format === 'unreadable-pdf') entry.note = 'text uses a font encoding pdftotext cannot decode; not covered';
  else entry.note = 'format listed only, not parsed';
  return { entry };
}

function main() {
  const files = folders.flatMap((folder) => listFiles(path.resolve(folder.replace(/^~/, process.env.HOME))));
  const inventory = [];
  const sources = [];
  for (const file of files) {
    const { entry, transactions, kind } = readFile(file);
    entry.file = path.basename(file).replace(/^\d+ - /, ''); // drop the account-digit prefix
    inventory.push(entry);
    if (!transactions) continue;
    const dates = transactions.map((t) => t.date).filter(Boolean).sort();
    entry.dateRange = dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
    entry.parsed = true;
    entry.transactions = transactions.length;
    // A statement's month is the month it closes: the period end for a PDF,
    // the "MM YYYY" in an Amex CSV's name (its rows start the month before).
    const named = path.basename(file).match(/(\d{2}) (\d{4})\.csv$/i);
    entry.month = entry.period ? monthOf(entry.period.to) : named ? `${named[2]}-${named[1]}` : monthOf(dates[dates.length - 1]);
    // A name whose year disagrees with its rows: keep its month, take the
    // year from the rows.
    const last = dates[dates.length - 1];
    if (named && last && !monthsBetween(monthOf(last), entry.month).slice(0, 3).includes(entry.month)) {
      const year = Number(last.slice(0, 4)) + (Number(named[1]) < Number(last.slice(5, 7)) ? 1 : 0);
      entry.note = `file name says ${entry.month}, rows end ${monthOf(last)}; read as ${year}-${named[1]}`;
      entry.month = `${year}-${named[1]}`;
    }
    entry.sourceFile = `${entry.account} ${entry.month} ${kind}`;
    transactions.forEach((t) => { t.sourceFile = entry.sourceFile; });
    if (kind === 'pdf' && !entry.reconciliation.ok) continue; // failed statements stay out
    sources.push({ kind, account: entry.account, month: entry.month, sha256: entry.sha256, transactions });
  }

  // Label files whose content could not be read from their readable siblings.
  const labelled = inventory.filter((e) => e.account);
  for (const entry of inventory.filter((e) => !e.account)) {
    const sibling = labelled.find((e) => e.folder === entry.folder);
    if (/PC Financial/i.test(entry.folder)) entry.account = 'PC Financial';
    else if (sibling) entry.account = sibling.account;
    entry.labelFrom = 'folder';
  }

  // Same bytes read twice: keep the first.
  const byHash = new Map();
  const duplicateFiles = [];
  for (const entry of inventory.filter((e) => e.sha256)) {
    if (byHash.has(entry.sha256)) duplicateFiles.push({ account: entry.account, month: entry.month || null, folder: entry.folder, sameAs: byHash.get(entry.sha256).folder });
    else byHash.set(entry.sha256, entry);
  }
  const firstSeen = new Set();
  const uniqueSources = sources.filter((s) => (firstSeen.has(s.sha256) ? false : firstSeen.add(s.sha256)));

  // Same account and month from two different files (CSV and PDF, or two
  // copies of one month that are not byte-identical).
  const monthFiles = new Map();
  for (const s of uniqueSources) {
    const key = `${s.account}|${s.month}`;
    monthFiles.set(key, [...(monthFiles.get(key) || []), s.kind]);
  }
  const overlaps = [...monthFiles].filter(([, kinds]) => kinds.length > 1).map(([key, kinds]) => ({ account: key.split('|')[0], month: key.split('|')[1], sources: kinds }));

  const { transactions, dropped } = statements.dedupeStatements(uniqueSources);
  transactions.sort((a, b) => a.account.localeCompare(b.account) || a.date.localeCompare(b.date));

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
    totals: Object.values(totals).sort((a, b) => a.account.localeCompare(b.account) || a.year.localeCompare(b.year) || a.kind.localeCompare(b.kind)),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'transactions.json'), `${JSON.stringify(transactions, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${inventory.length} files, ${report.reconciliation.passed} statements reconciled, ${failed.length} failed, ${transactions.length} transactions`);
  console.log(`Wrote ${path.join(outDir, 'transactions.json')} and report.json`);
}

main();
