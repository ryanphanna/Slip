// Finds and reads statement files from disk into deduplicated transactions
// (CIV-1186). Shared by scripts/read-statements.js and
// scripts/upload-statements.js. File names often carry account digits, so
// nothing returned here keeps a file name with its prefix.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const statements = require('./statements');

// Earlier outputs and folders that are not statements.
const SKIP_NAMES = [/^spending-v3-/, /^simplii-8956-review\.csv$/, /^\./];
const SKIP_FOLDERS = [/Simplii Court Case/i];

const monthOf = (date) => (date ? date.slice(0, 7) : null);

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

// Every statement file under a folder (or the file itself).
function listFiles(target) {
  const full = path.resolve(String(target).replace(/^~/, process.env.HOME));
  if (fs.statSync(full).isFile()) return /\.(pdf|csv)$/i.test(full) ? [full] : [];
  if (SKIP_FOLDERS.some((re) => re.test(full))) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_NAMES.some((re) => re.test(entry.name))) return [];
    const child = path.join(full, entry.name);
    if (entry.isDirectory()) return listFiles(child);
    return /\.(pdf|csv)$/i.test(entry.name) ? [child] : [];
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

// The label for a file from its name prefix ("41001 - 03 2026.csv"), or null.
function prefixLabel(file, accounts) {
  const prefix = Object.keys(accounts || {}).find((key) => path.basename(file).startsWith(`${key} `));
  return prefix ? accounts[prefix] : null;
}

// Reads one file. `accounts` maps a file-name prefix to a label. CSVs name no
// account, so they need one; with `labelPdfs`, a PDF's prefix label also
// wins over the label read from its text.
function readFile(file, { accounts = {}, labelPdfs = false } = {}) {
  const folder = path.dirname(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const entry = { folder, format: null, account: null, sha256: null, period: null, dateRange: null, parsed: false, note: null };
  if (notDownloaded(file)) {
    entry.format = `${ext} (not downloaded from iCloud)`;
    entry.monthHint = (path.basename(file).match(/^(\d{4})-(\d{2})\.pdf$/) || []).slice(1).join('-') || null;
    return { entry };
  }
  entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const named = prefixLabel(file, accounts);

  if (ext === 'csv') {
    entry.format = 'amex-csv';
    entry.account = named;
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
  entry.account = (labelPdfs && named) || described.label;
  entry.period = described.period || null;
  if (described.noActivity) entry.note = 'no activity in this period';
  if (described.format === 'amex-pdf' || described.format === 'simplii-chequing-pdf') {
    const result = described.format === 'amex-pdf'
      ? statements.parseAmexPdf(text, { sourceFile: null })
      : statements.parseSimpliiChequingPdf(text, { sourceFile: null });
    entry.period = result.period;
    entry.reconciliation = result.reconciliation;
    if (labelPdfs && named) result.transactions.forEach((t) => { t.account = named; });
    return { entry, transactions: result.transactions, kind: 'pdf' };
  }
  if (described.format === 'unreadable-pdf') entry.note = 'text uses a font encoding pdftotext cannot decode; not covered';
  else entry.note = 'format listed only, not parsed';
  return { entry };
}

// Reads every file, drops failed statements, byte-identical copies and lines
// that appear in two sources. Returns the inventory, the sources kept, the
// duplicate files, and the deduplicated transactions sorted by account and date.
function readStatementFiles(files, options = {}) {
  const inventory = [];
  const sources = [];
  for (const file of files) {
    const { entry, transactions, kind } = readFile(file, options);
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

  // Same bytes read twice: keep the first.
  const byHash = new Map();
  const duplicateFiles = [];
  for (const entry of inventory.filter((e) => e.sha256)) {
    if (byHash.has(entry.sha256)) duplicateFiles.push({ account: entry.account, month: entry.month || null, folder: entry.folder, sameAs: byHash.get(entry.sha256).folder });
    else byHash.set(entry.sha256, entry);
  }
  const firstSeen = new Set();
  const uniqueSources = sources.filter((s) => (firstSeen.has(s.sha256) ? false : firstSeen.add(s.sha256)));

  const { transactions, dropped } = statements.dedupeStatements(uniqueSources);
  transactions.sort((a, b) => a.account.localeCompare(b.account) || a.date.localeCompare(b.date));
  return { inventory, uniqueSources, duplicateFiles, transactions, dropped };
}

module.exports = { listFiles, readFile, readStatementFiles, prefixLabel, monthsBetween, monthOf };
