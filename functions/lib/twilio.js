const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');
const twilio = require('twilio');
const { readConfigValue } = require('./runtime-health');

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');
const webhookUrlSecret = defineSecret('WEBHOOK_URL');

const ALLOWED_MEDIA_HOSTS = new Set([
  'api.twilio.com',
  'mms.twilio.com',
  'mms.twiliocdn.com',
  'media.twiliocdn.com',
]);

function parseForwardedValues(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function buildRequestUrls(req) {
  const configuredWebhookUrl = readConfigValue('WEBHOOK_URL', webhookUrlSecret).value.trim();
  const requestPath = req.originalUrl || req.url || '/';
  const rawHost = req.get?.('host') || req.headers.host;
  const forwardedHosts = parseForwardedValues(req.headers['x-forwarded-host']);
  const forwardedProtos = parseForwardedValues(req.headers['x-forwarded-proto']);
  const hosts = [...forwardedHosts, rawHost].filter(Boolean);
  const protos = [...forwardedProtos, req.protocol, 'https'].filter(Boolean);
  const urls = new Set();
  const functionName = process.env.K_SERVICE || process.env.FUNCTION_TARGET || 'sms';
  const region = process.env.FUNCTION_REGION || process.env.GCLOUD_REGION || 'us-central1';
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;

  function addUrl(url) {
    if (!url) return;
    urls.add(url);
    if (url.endsWith('/')) urls.add(url.slice(0, -1));
    else urls.add(`${url}/`);
  }

  addUrl(configuredWebhookUrl);

  for (const proto of protos) {
    for (const host of hosts) {
      const normalizedProto = String(proto).toLowerCase() === 'http' ? 'http' : 'https';
      const baseUrl = `${normalizedProto}://${host}`;
      addUrl(`${baseUrl}${requestPath}`);

      const normalizedPath = requestPath === '/' ? '' : requestPath.replace(/\/$/, '');
      addUrl(`${baseUrl}${normalizedPath}`);

      if (normalizedPath !== `/${functionName}`) {
        addUrl(`${baseUrl}/${functionName}`);
      }
    }
  }

  if (projectId) {
    addUrl(`https://${region}-${projectId}.cloudfunctions.net/${functionName}`);
  }

  return [...urls];
}

function readRequiredConfig(envName, secretParam) {
  return readConfigValue(envName, secretParam).value.trim();
}

function signatureMatches(authToken, signature, url, params) {
  const expected = twilio.getExpectedTwilioSignature(authToken, url, params);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function validateTwilioSignature(req) {
  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    logger.warn('No x-twilio-signature header found');
    return false;
  }

  const authToken = readRequiredConfig('TWILIO_AUTH_TOKEN', twilioAuthToken);
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const candidates = buildRequestUrls(req);

  for (const candidateUrl of candidates) {
    if (
      twilio.validateRequest(authToken, signature, candidateUrl, params) ||
      signatureMatches(authToken, signature, candidateUrl, params)
    ) {
      return true;
    }
  }

  logger.warn('Twilio signature validation failed for all candidate request URLs', { candidates });
  return false;
}

async function sendSms(to, body) {
  const client = twilio(
    readRequiredConfig('TWILIO_ACCOUNT_SID', twilioAccountSid),
    readRequiredConfig('TWILIO_AUTH_TOKEN', twilioAuthToken)
  );
  await client.messages.create({
    body,
    from: readRequiredConfig('TWILIO_PHONE_NUMBER', twilioPhoneNumber),
    to,
  });
}

function validateMediaUrl(url, baseUrl) {
  const parsed = new URL(url, baseUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Blocked media URL with non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (!ALLOWED_MEDIA_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Blocked media URL host: ${parsed.hostname}`);
  }
  return parsed.toString();
}

function shouldSendAuth(url) {
  const host = new URL(url).hostname.toLowerCase();
  return host === 'api.twilio.com' || host === 'mms.twilio.com';
}

async function fetchMedia(mediaUrl) {
  const credentials = Buffer.from(
    `${readRequiredConfig('TWILIO_ACCOUNT_SID', twilioAccountSid)}:${readRequiredConfig('TWILIO_AUTH_TOKEN', twilioAuthToken)}`
  ).toString('base64');

  // Validate the webhook-supplied URL against allowlist (SSRF protection on user-controlled input)
  let currentUrl = validateMediaUrl(mediaUrl);

  for (let i = 0; i < 4; i++) {
    const headers = shouldSendAuth(currentUrl) ? { Authorization: `Basic ${credentials}` } : {};
    const res = await fetch(currentUrl, { headers, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirected Twilio media response missing location header');
      // CDN redirects come from Twilio's server (not user input) — enforce HTTPS only
      const parsed = new URL(location, currentUrl);
      if (parsed.protocol !== 'https:') throw new Error(`Blocked non-HTTPS media redirect`);
      currentUrl = parsed.toString();
      continue;
    }
    if (!res.ok) throw new Error(`Failed to fetch Twilio media: ${res.status}`);
    return res;
  }

  throw new Error('Too many redirects while fetching Twilio media');
}

module.exports = {
  validateTwilioSignature,
  sendSms,
  fetchMedia,
  buildRequestUrls,           // Exported for unit testing the complex URL generation logic
  parseForwardedValues,       // Exported for unit testing
};
