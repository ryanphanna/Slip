const twilio = require('twilio');
const { defineSecret } = require('firebase-functions/params');

const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');

function getTwilioClient() {
  const accountSid = twilioAccountSid.value();
  const authToken = twilioAuthToken.value();
  if (!accountSid || !authToken) return null;
  return twilio(accountSid, authToken);
}

function getTwilioPhoneNumber() {
  return twilioPhoneNumber.value();
}

function twimlResponse(message) {
  if (!message) return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

function validateTwilioSignature(req) {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    console.warn('Twilio signature validation skipped (emulator)');
    return true;
  }

  const authToken = twilioAuthToken.value();
  if (!authToken) return false;

  const twilioSig = req.headers['x-twilio-signature'];
  if (!twilioSig) return false;

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;

  if (twilio.validateRequest(authToken, twilioSig, url, req.body)) return true;

  const fallback = `${protocol}://${host}/sms`;
  return twilio.validateRequest(authToken, twilioSig, fallback, req.body);
}

module.exports = { getTwilioClient, getTwilioPhoneNumber, twimlResponse, validateTwilioSignature };
