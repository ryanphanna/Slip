#!/usr/bin/env node
const crypto = require('crypto');
const twilio = require('twilio');

function getEnv(name, fallback = '') {
  return process.env[name] || fallback;
}

function requireEnv(name) {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function buildSignature(authToken, url, params) {
  const data = url + Object.keys(params)
    .sort()
    .map(key => key + params[key])
    .join('');
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
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
  const webhookUrl = requireEnv('WEBHOOK_URL');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');
  const to = requireEnv('TWILIO_PHONE_NUMBER');
  const from = getEnv('SMOKE_FROM') || getEnv('ALLOWED_PHONES').split(',')[0]?.trim();
  if (!from) throw new Error('Set SMOKE_FROM or ALLOWED_PHONES for the smoke sender');

  const body = process.argv[2] || 'LAST';
  const accountSid = getEnv('TWILIO_ACCOUNT_SID');
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
