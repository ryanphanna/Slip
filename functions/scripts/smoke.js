#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const twilio = require('twilio');

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

function buildSignature(authToken, url, params) {
  return twilio.getExpectedTwilioSignature(authToken, url, params);
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyReply({ accountSid, authToken, from, to, startedAt }) {
  const client = twilio(accountSid, authToken);

  for (let attempt = 0; attempt < 10; attempt++) {
    const messages = await client.messages.list({ to: from, from: to, limit: 10 });
    const matching = messages.find(message =>
      new Date(message.dateCreated).getTime() >= startedAt.getTime()
    );

    if (matching) {
      console.log(JSON.stringify({
        ok: true,
        replySid: matching.sid,
        replyStatus: matching.status,
        replyBody: matching.body,
      }, null, 2));
      return;
    }

    await sleep(3000);
  }

  throw new Error('No outbound reply detected within 30 seconds');
}

async function main() {
  const webhookUrl = requireConfig('WEBHOOK_URL');
  const authToken = requireConfig('TWILIO_AUTH_TOKEN');
  const to = requireConfig('TWILIO_PHONE_NUMBER');
  const from = getEnv('SMOKE_FROM') || getConfig('ALLOWED_PHONES').split(',')[0]?.trim();
  if (!from) throw new Error('Set SMOKE_FROM or ALLOWED_PHONES for the smoke sender');

  const body = process.argv[2] || 'LAST';
  const accountSid = getConfig('TWILIO_ACCOUNT_SID');
  const messageSid = `SMOKE-${Date.now()}`;
  const params = {
    AccountSid: accountSid || 'ACSMOKE',
    Body: body,
    From: from,
    MessageSid: messageSid,
    NumMedia: '0',
    To: to,
  };

  const signature = buildSignature(authToken, webhookUrl, params);
  const startedAt = new Date();
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    },
    body: new URLSearchParams(params),
  });

  const responseBody = await response.text();
  console.log(JSON.stringify({
    ok: response.ok,
    status: response.status,
    messageSid,
    responseBody,
  }, null, 2));

  if (!response.ok) {
    process.exit(1);
  }

  if (accountSid) {
    await verifyReply({ accountSid, authToken, from, to, startedAt });
  } else {
    console.log('Skipping outbound reply verification because TWILIO_ACCOUNT_SID is not set.');
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
