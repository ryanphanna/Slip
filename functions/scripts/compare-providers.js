#!/usr/bin/env node
// Compare receipt parsing by Gemini (the production path) and Claude on receipts
// that are already stored, next to the value saved in Firestore today.
//
// READ-ONLY: this script only reads Firestore and Storage. It never changes a
// receipt. Its only output is local files in the output folder.
//
// Usage (from functions/):
//   node scripts/compare-providers.js --dry-run              list what would run, no AI calls
//   node scripts/compare-providers.js --limit 10             newest 10 receipts not yet compared
//   node scripts/compare-providers.js --ids abc123,def456    specific receipts
//   node scripts/compare-providers.js --report-only          rebuild report.html from results.json
//
// Flags:
//   --limit N             how many receipts to process this run (default 10)
//   --dry-run             list the receipts and the total available; makes zero AI calls
//   --since DATE          only receipts received on or after DATE (e.g. 2026-09-01)
//   --providers a,b       gemini, claude or both (default both)
//   --ids a,b / --id a    specific receipt IDs (bare IDs also work)
//   --claude-model NAME   default claude-opus-5-5 (or env CLAUDE_MODEL)
//   --claude-effort LEVEL low | medium | high | xhigh | max, default low (or env CLAUDE_EFFORT)
//   --retry-failed        run again for receipts where a provider failed last time
//   --delay-ms N          pause between receipts (default 1500)
//   --out DIR             output folder (default functions/compare-output, hidden from git)
//
// Needs: GEMINI_API_KEY (env, functions/.env, or the Firebase secret, as in
// reparse.js) for Gemini, and ANTHROPIC_API_KEY in the environment for Claude.
// Both cost real money per receipt. A run can be stopped and started again:
// receipts already in results.json are skipped. To try another Claude model,
// use a different --out folder so the two runs stay apart.
//
// Output: results.json, report.html and images/ in the output folder. They hold
// personal financial data, so the folder is listed in .git/info/exclude.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  PROVIDERS, parseArgs, tallyLine, renderReport,
} = require('./compare-lib');

const DEFAULT_OUT = path.join(__dirname, '..', 'compare-output');

// ---------- config, same approach as reparse.js ----------

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function getSecret(name) {
  const version = process.env.SMOKE_SECRET_VERSION || '1';
  try {
    return execFileSync('firebase', ['functions:secrets:access', `${name}@${version}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) { return ''; }
}

// With gcloud application-default credentials there is no project ID in the
// environment, and Storage reads get charged to whatever "quota project" the
// login last used (another project here, which makes photo downloads fail with
// a billing error). Point both at this repo's project from .firebaserc, for
// this process only. A service account file carries its own and is unaffected.
function useDefaultProject() {
  let project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!project) {
    try {
      const rc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.firebaserc'), 'utf8'));
      project = rc.projects && rc.projects.default;
    } catch (_) { /* no .firebaserc: fall through to the SDK's own lookup */ }
    if (project) process.env.GOOGLE_CLOUD_PROJECT = project;
  }
  if (project && !process.env.GOOGLE_CLOUD_QUOTA_PROJECT) process.env.GOOGLE_CLOUD_QUOTA_PROJECT = project;
}

// Stops before any paid call if a requested provider has no credentials.
function requireKeys(providers) {
  if (providers.includes('gemini')) {
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || getSecret('GEMINI_API_KEY');
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('Missing GEMINI_API_KEY (set it in the environment or functions/.env, or log in to the firebase CLI)');
    }
  }
  if (providers.includes('claude')) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE) {
      throw new Error('Missing ANTHROPIC_API_KEY (export it before running, or use --providers gemini)');
    }
  }
}

// ---------- results file ----------

function readResults(outDir) {
  const file = path.join(outDir, 'results.json');
  if (!fs.existsSync(file)) return { version: 1, results: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.results)) throw new Error(`${file} is not a results file`);
  return data;
}

function writeResults(outDir, data) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = path.join(outDir, 'results.json');
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function writeReport(outDir, data) {
  const loadImage = (relative) => {
    const file = path.join(outDir, relative);
    if (!fs.existsSync(file)) return '';
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : file.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  };
  const html = renderReport(data.results, {
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    claudeModel: data.claudeModel,
    claudeEffort: data.claudeEffort,
  }, loadImage);
  const file = path.join(outDir, 'report.html');
  fs.writeFileSync(file, html, { mode: 0o600 });
  return file;
}

// Which providers still need to run for a receipt, given what is already saved.
function providersNeeded(existing, providers, retryFailed) {
  return providers.filter((name) => {
    const answer = existing && existing.providers && existing.providers[name];
    if (!answer) return true;
    return retryFailed && !answer.ok;
  });
}

/**
 * Pick the receipts to process this run.
 * @param {Array<{id: string}>} candidates - newest first, already limited to receipts with photos
 * @param {Array} saved - results already in results.json
 * @returns {Array<{candidate, providers: string[]}>}
 */
function selectWork(candidates, saved, { providers, limit, ids = [], retryFailed = false }) {
  const byId = new Map(saved.map((result) => [result.id, result]));
  const pool = ids.length ? candidates.filter((candidate) => ids.includes(candidate.id)) : candidates;
  const work = [];
  for (const candidate of pool) {
    const needed = providersNeeded(byId.get(candidate.id), providers, retryFailed);
    if (needed.length === 0) continue;
    work.push({ candidate, providers: needed });
    if (!ids.length && work.length >= limit) break;
  }
  return work;
}

// ---------- stored receipts (read-only) ----------

function isoTime(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function listCandidates(db, { since, ids }) {
  if (ids.length) {
    const found = [];
    for (const id of ids) {
      const snap = await db.collection('receipts').doc(id).get();
      if (!snap.exists) { console.error(`[${id}] Not found in Firestore.`); continue; }
      found.push({ id, ...snap.data() });
    }
    const withImages = found.filter((doc) => (doc.imagePaths || []).length > 0);
    found.filter((doc) => !withImages.includes(doc)).forEach((doc) => console.error(`[${doc.id}] No stored photos, skipped.`));
    return { totalReceipts: found.length, candidates: withImages };
  }

  let query = db.collection('receipts').orderBy('createdAt', 'desc');
  if (since) query = query.where('createdAt', '>=', new Date(since));
  const snap = await query.select('imagePaths', 'createdAt', 'merchant', 'date', 'total').get();
  const all = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return { totalReceipts: all.length, candidates: all.filter((doc) => (doc.imagePaths || []).length > 0) };
}

async function downloadImage(bucket, imagePath) {
  const file = bucket.file(imagePath);
  const [buffer] = await file.download();
  const [meta] = await file.getMetadata();
  return { base64: buffer.toString('base64'), mimeType: meta.contentType || 'image/jpeg' };
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' };

// Save a small copy of each photo for the report. Uses macOS `sips` to shrink
// it; if that is unavailable the original is kept as it is.
function saveThumbs(outDir, id, images) {
  const dir = path.join(outDir, 'images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return images.map((image, index) => {
    const original = path.join(dir, `${id}-${index}.orig.${EXTENSIONS[image.mimeType] || 'jpg'}`);
    const thumb = path.join(dir, `${id}-${index}.jpg`);
    fs.writeFileSync(original, Buffer.from(image.base64, 'base64'), { mode: 0o600 });
    try {
      execFileSync('sips', ['-Z', '900', '-s', 'format', 'jpeg', original, '--out', thumb], { stdio: 'ignore' });
      fs.rmSync(original);
      return path.join('images', path.basename(thumb));
    } catch (_) {
      return path.join('images', path.basename(original));
    }
  });
}

// The columns the report compares, from either a stored receipt or a parse result.
function toView(receipt) {
  const items = Array.isArray(receipt.items) ? receipt.items : [];
  return {
    merchant: receipt.merchant ?? null,
    date: receipt.date ?? null,
    total: receipt.total ?? null,
    tax: receipt.tax ?? null,
    confidence: receipt.confidence ?? null,
    itemCount: items.length,
    items: items.map((item) => ({ name: item.name, price: item.price ?? null, quantity: item.quantity ?? 1 })),
  };
}

// ---------- providers ----------

// Count Gemini calls and tokens by watching the SDK from outside, so the
// production parser in lib/gemini.js runs untouched, fallback chain included.
let geminiTracker = null;
function watchGemini() {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const original = GoogleGenerativeAI.prototype.getGenerativeModel;
  GoogleGenerativeAI.prototype.getGenerativeModel = function watched(params, ...rest) {
    const model = original.call(this, params, ...rest);
    const generate = model.generateContent.bind(model);
    model.generateContent = async (...args) => {
      const tracker = geminiTracker; // a late answer from an abandoned call lands on its own receipt
      if (tracker) {
        tracker.calls += 1;
        if (!tracker.models.includes(params.model)) tracker.models.push(params.model);
      }
      const result = await generate(...args);
      const usage = result && result.response && result.response.usageMetadata;
      if (tracker && usage) {
        tracker.inputTokens += usage.promptTokenCount || 0;
        tracker.outputTokens += (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
      }
      return result;
    };
    return model;
  };
}

async function runGemini(images) {
  const { parseReceiptFromBase64 } = require('../lib/receipt');
  const { validateReceipt } = require('../lib/validate');
  const tracker = { calls: 0, models: [], inputTokens: 0, outputTokens: 0 };
  geminiTracker = tracker;
  const started = Date.now();
  try {
    const raw = await parseReceiptFromBase64(images);
    const receipt = validateReceipt(raw);
    if (raw.confidence != null) receipt.confidence = raw.confidence;
    return { ok: true, error: null, ...toView(receipt), ms: Date.now() - started, ...tracker };
  } catch (err) {
    return { ok: false, error: err.message || String(err), ms: Date.now() - started, ...tracker };
  } finally {
    geminiTracker = null;
  }
}

async function runClaude(images, args) {
  const { parseReceiptWithClaude } = require('../lib/claude');
  const { validateReceipt } = require('../lib/validate');
  const result = await parseReceiptWithClaude(images, {
    model: args.claudeModel || undefined,
    effort: args.claudeEffort || undefined,
  });
  const common = {
    ms: result.ms, calls: result.calls, models: [result.model],
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    stopReason: result.stopReason,
  };
  if (!result.ok) return { ok: false, error: result.error, ...common };
  // Same clean-up production applies to a Gemini answer before saving it.
  const receipt = validateReceipt(result.receipt);
  if (result.receipt.confidence != null) receipt.confidence = result.receipt.confidence;
  return { ok: true, error: null, ...toView(receipt), ...common };
}

// ---------- main ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(candidate) {
  const day = (isoTime(candidate.createdAt) || '').slice(0, 10) || '?';
  const total = typeof candidate.total === 'number' ? candidate.total.toFixed(2) : '?';
  return `${candidate.id}  received ${day}  ${String(candidate.merchant || 'Unknown').padEnd(24).slice(0, 24)}  ${total.padStart(9)}  ${(candidate.imagePaths || []).length} photo(s)`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out || DEFAULT_OUT);
  const data = readResults(outDir);

  if (args.reportOnly) {
    console.log(`Report written: ${writeReport(outDir, data)} (${data.results.length} receipts)`);
    return;
  }

  loadDotenv(path.join(__dirname, '..', '.env'));
  useDefaultProject();
  if (!args.dryRun) requireKeys(args.providers);

  const admin = require('firebase-admin');
  const { initializeAdminApp } = require('../lib/admin');
  const { credentialSource } = initializeAdminApp();
  const db = admin.firestore();

  const { totalReceipts, candidates } = await listCandidates(db, args);
  const work = selectWork(candidates, data.results, args);
  const alreadyDone = candidates.length - selectWork(candidates, data.results, { ...args, limit: Infinity }).length;

  console.log(`Credentials: ${credentialSource}`);
  console.log(`Receipts found${args.since ? ` since ${args.since}` : ''}: ${totalReceipts}`);
  console.log(`With stored photos (available to compare): ${candidates.length}`);
  console.log(`Already compared in ${path.join(outDir, 'results.json')}: ${alreadyDone}`);
  console.log(`${args.dryRun ? 'Would process' : 'Processing'} ${work.length} receipt(s) with: ${args.providers.join(', ')}`);

  if (args.dryRun) {
    work.forEach(({ candidate, providers }) => console.log(`  ${describe(candidate)}  [${providers.join(', ')}]`));
    console.log('Dry run: no AI calls made, nothing written.');
    return;
  }
  if (work.length === 0) {
    console.log(`Nothing to do. Report: ${writeReport(outDir, data)}`);
    return;
  }

  const { DEFAULT_MODEL, DEFAULT_EFFORT } = require('../lib/claude');
  if (args.providers.includes('claude')) {
    data.claudeModel = args.claudeModel || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
    data.claudeEffort = args.claudeEffort || process.env.CLAUDE_EFFORT || DEFAULT_EFFORT;
  }
  if (args.providers.includes('gemini')) watchGemini();
  const bucket = admin.storage().bucket();

  for (let index = 0; index < work.length; index++) {
    const { candidate, providers } = work[index];
    const id = candidate.id;
    try {
      const snap = await db.collection('receipts').doc(id).get();
      const stored = snap.data();
      console.log(`[${index + 1}/${work.length}] ${id}: downloading ${stored.imagePaths.length} photo(s)...`);
      const images = await Promise.all(stored.imagePaths.map((imagePath) => downloadImage(bucket, imagePath)));

      let result = data.results.find((entry) => entry.id === id);
      if (!result) {
        result = { id, providers: {} };
        data.results.push(result);
      }
      result.createdAt = isoTime(stored.createdAt);
      result.imageCount = images.length;
      result.thumbs = saveThumbs(outDir, id, images);
      result.stored = toView(stored);

      for (const name of providers) {
        const answer = name === 'gemini' ? await runGemini(images) : await runClaude(images, args);
        result.providers[name] = answer;
        const outcome = answer.ok ? `${answer.merchant} ${answer.date} ${answer.total}` : `failed: ${answer.error}`;
        console.log(`    ${name}: ${outcome} (${(answer.ms / 1000).toFixed(1)} s, ${answer.calls} call(s))`);
        writeResults(outDir, data);
      }
    } catch (err) {
      // One bad receipt (missing photo, network blip) must not stop the run.
      console.error(`[${id}] Skipped: ${err.message}`);
    }
    console.log(`    Tally: ${tallyLine(data.results)}`);
    if (index < work.length - 1) await sleep(args.delayMs);
  }

  writeResults(outDir, data);
  console.log(`Results: ${path.join(outDir, 'results.json')}`);
  console.log(`Report:  ${writeReport(outDir, data)}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { PROVIDERS, providersNeeded, selectWork, toView, readResults, writeReport };
