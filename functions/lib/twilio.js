const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const twilio = require('twilio');

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');

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
  const requestPath = req.originalUrl || req.url || '/';
  const rawHost = req.get?.('host') || req.headers.host;
  const forwardedHosts = parseForwardedValues(req.headers['x-forwarded-host']);
  const forwardedProtos = parseForwardedValues(req.headers['x-forwarded-proto']);
  const hosts = [...forwardedHosts, rawHost].filter(Boolean);
  const protos = [...forwardedProtos, req.protocol, 'https'].filter(Boolean);
  const urls = [];

  for (const proto of protos) {
    for (const host of hosts) {
      const normalizedProto = String(proto).toLowerCase() === 'http' ? 'http' : 'https';
      urls.push(`${normalizedProto}://${host}${requestPath}`);
    }
  }

  return [...new Set(urls)];
}

function validateTwilioSignature(req) {
  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    logger.warn('No x-twilio-signature header found');
    return false;
  }

  const authToken = twilioAuthToken.value();
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const candidates = buildRequestUrls(req);

  for (const candidateUrl of candidates) {
    if (twilio.validateRequest(authToken, signature, candidateUrl, params)) {
      return true;
    }
  }

  logger.warn('Twilio signature validation failed for all candidate request URLs', { candidates });
  return false;
}

async function sendSms(to, body) {
  const client = twilio(twilioAccountSid.value(), twilioAuthToken.value());
  await client.messages.create({ body, from: twilioPhoneNumber.value(), to });
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
    `${twilioAccountSid.value()}:${twilioAuthToken.value()}`
  ).toString('base64');

  let currentUrl = validateMediaUrl(mediaUrl);
  for (let i = 0; i < 4; i++) {
    const headers = shouldSendAuth(currentUrl) ? { Authorization: `Basic ${credentials}` } : {};
    const res = await fetch(currentUrl, { headers, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirected Twilio media response missing location header');
      currentUrl = validateMediaUrl(location, currentUrl);
      continue;
    }
    if (!res.ok) throw new Error(`Failed to fetch Twilio media: ${res.status}`);
    return res;
  }

  throw new Error('Too many redirects while fetching Twilio media');
}

module.exports = { validateTwilioSignature, sendSms, fetchMedia };
