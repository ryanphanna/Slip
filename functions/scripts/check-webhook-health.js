#!/usr/bin/env node
const twilio = require('twilio');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main() {
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');
  const minutes = Number.parseInt(process.env.WEBHOOK_HEALTH_WINDOW_MINUTES || '30', 10);
  const threshold = Number.parseInt(process.env.WEBHOOK_HEALTH_11200_THRESHOLD || '1', 10);
  const since = Date.now() - minutes * 60 * 1000;

  const client = twilio(accountSid, authToken);
  const messages = await client.messages.list({ limit: 50 });
  const recent11200 = messages.filter(message =>
    message.direction === 'inbound' &&
    message.errorCode === 11200 &&
    new Date(message.dateCreated).getTime() >= since
  );

  console.log(JSON.stringify({
    windowMinutes: minutes,
    threshold,
    failures: recent11200.map(message => ({
      sid: message.sid,
      from: message.from,
      to: message.to,
      body: message.body,
      dateCreated: message.dateCreated,
      errorCode: message.errorCode,
    })),
  }, null, 2));

  if (recent11200.length >= threshold) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
