const { defineSecret } = require('firebase-functions/params');
const twilio = require('twilio');

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');

function validateTwilioSignature(req) {
  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    console.warn('No x-twilio-signature header found');
    return false;
  }

  // Use the exact URL configured in Twilio's dashboard (stored in WEBHOOK_URL env var)
  // to avoid proxy header mismatches behind Cloud Run
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('WEBHOOK_URL not set — skipping signature validation');
    return true;
  }

  const token = twilioAuthToken.value();
  return twilio.validateRequest(token, signature, webhookUrl, req.body);
}

async function sendSms(to, body) {
  const client = twilio(twilioAccountSid.value(), twilioAuthToken.value());
  await client.messages.create({ body, from: twilioPhoneNumber.value(), to });
}

async function fetchMedia(mediaUrl) {
  const credentials = Buffer.from(
    `${twilioAccountSid.value()}:${twilioAuthToken.value()}`
  ).toString('base64');
  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Twilio media: ${res.status}`);
  return res;
}

module.exports = { validateTwilioSignature, sendSms, fetchMedia };
