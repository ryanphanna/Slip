#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const twilio = require('twilio');
const { initializeAdminApp } = require('../lib/admin');
const { fetchMedia } = require('../lib/twilio');
const { parseReceiptFromBase64 } = require('../lib/receipt');
const { validateReceipt } = require('../lib/validate');
const { saveReceipt, findDuplicate } = require('../lib/store');
const { saveImages } = require('../lib/image-store');

const initializedAdmin = initializeAdminApp();
const admin = initializedAdmin && initializedAdmin.admin ? initializedAdmin.admin : require('firebase-admin');

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadDotenv(path.join(__dirname, '..', '.env'));

function getEnv(name, fallback = '') {
  return process.env[name] || fallback;
}

function getSecret(name) {
  const version = process.env.SMOKE_SECRET_VERSION || '1';
  try {
    return execFileSync('firebase', ['functions:secrets:access', `${name}@${version}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '';
  }
}

function getConfig(name, fallback = '') {
  return getEnv(name) || getSecret(name) || fallback;
}

function requireConfig(name) {
  const value = getConfig(name);
  if (!value) {
    throw new Error(`Missing required config: ${name}`);
  }
  return value;
}

function parsePhones(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    limit: Number.parseInt(process.env.REPLAY_LIMIT || '1000', 10),
    since: process.env.REPLAY_SINCE || '',
    from: parsePhones(process.env.REPLAY_FROM || ''),
    notify: process.env.REPLAY_NOTIFY === '1',
  };

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (current === '--since') args.since = argv[++i];
    else if (current === '--from') args.from = parsePhones(argv[++i]);
    else if (current === '--notify') args.notify = true;
    else if (current === '--silent') args.notify = false;
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error('Replay limit must be a positive number');
  }

  return args;
}

function uniquePhones(phones) {
  return [...new Set(phones.filter(Boolean))];
}

function selectReplaySenders(args) {
  if (args.from.length > 0) return uniquePhones(args.from);

  const allowlisted = parsePhones(getConfig('ALLOWED_PHONES'));
  if (allowlisted.length > 0) return uniquePhones(allowlisted);

  throw new Error('Set REPLAY_FROM or ALLOWED_PHONES to choose which senders to replay');
}

function shouldConsiderMessage(message, senders, sinceTime) {
  if (!message || message.direction !== 'inbound') return false;
  if (sinceTime && new Date(message.dateCreated).getTime() < sinceTime) return false;
  if (senders.length > 0 && !senders.includes(message.from)) return false;
  return Number.parseInt(message.numMedia || '0', 10) > 0;
}

async function loadMediaImages(client, messageSid) {
  const mediaList = await client.messages(messageSid).media.list({ limit: 100 });
  const images = [];

  for (const media of mediaList) {
    const mediaUrl = `https://api.twilio.com${media.uri.replace('.json', '')}`;
    const imgResponse = await fetchMedia(mediaUrl);
    const mimeType = imgResponse.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await imgResponse.arrayBuffer());
    images.push({ base64: buffer.toString('base64'), mimeType });
  }

  return images;
}

function buildSummaryLine({ merchant, total, category }) {
  const safeMerchant = merchant || 'Unknown';
  const safeTotal = total != null ? `$${Math.abs(total).toFixed(2)}` : '?';
  return `${safeMerchant} — ${safeTotal} (${category || 'Other'})`;
}

async function processMessage(client, msg, { notify }) {
  const existing = await admin.firestore()
    .collection('receipts')
    .where('messageSid', '==', msg.sid)
    .limit(1)
    .get();

  if (!existing.empty) {
    return { status: 'skipped', reason: 'already-processed' };
  }

  const images = await loadMediaImages(client, msg.sid);
  if (images.length === 0) {
    return { status: 'skipped', reason: 'no-media' };
  }

  const raw = await parseReceiptFromBase64(images);
  const receipt = validateReceipt(raw);

  const duplicateId = await findDuplicate(receipt, msg.from);
  if (duplicateId) {
    return { status: 'skipped', reason: 'duplicate', duplicateId };
  }

  const imagePaths = await saveImages(images, msg.sid);
  await saveReceipt(receipt, msg.from, msg.sid, imagePaths);

  if (notify) {
    const prefix = receipt.type === 'refund' ? 'Saved Refund' : 'Saved';
    await client.messages.create({
      body: `${prefix}: ${buildSummaryLine(receipt)}`,
      from: msg.to,
      to: msg.from,
    });
  }

  return { status: 'processed', receipt };
}

async function main() {
  const accountSid = requireConfig('TWILIO_ACCOUNT_SID');
  const authToken = requireConfig('TWILIO_AUTH_TOKEN');
  const to = requireConfig('TWILIO_PHONE_NUMBER');
  const args = parseArgs(process.argv.slice(2));
  const senders = selectReplaySenders(args);
  const sinceTime = args.since ? new Date(args.since).getTime() : null;

  if (sinceTime && Number.isNaN(sinceTime)) {
    throw new Error('Replay --since value must be a valid date');
  }

  const client = twilio(accountSid, authToken);
  const messages = await client.messages.list({
    direction: 'inbound',
    limit: args.limit,
    pageSize: Math.min(args.limit, 100),
  });

  const eligible = messages
    .filter(message => shouldConsiderMessage(message, senders, sinceTime))
    .sort((a, b) => new Date(a.dateCreated) - new Date(b.dateCreated));

  const summary = {
    checked: messages.length,
    eligible: eligible.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    notify: args.notify,
    senders,
    since: args.since || null,
  };

  for (const msg of eligible) {
    try {
      const result = await processMessage(client, msg, { notify: args.notify });
      if (result.status === 'processed') summary.processed += 1;
      else summary.skipped += 1;

      console.log(JSON.stringify({
        messageSid: msg.sid,
        from: msg.from,
        status: result.status,
        reason: result.reason || null,
        summary: result.receipt ? buildSummaryLine(result.receipt) : null,
      }, null, 2));
    } catch (err) {
      summary.failed += 1;
      console.error(JSON.stringify({
        messageSid: msg.sid,
        from: msg.from,
        status: 'failed',
        error: err.message || String(err),
      }, null, 2));
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parsePhones,
  shouldConsiderMessage,
  buildSummaryLine,
};
