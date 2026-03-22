const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { validateTwilioSignature, twimlResponse } = require('./lib/twilio');
const { parseReceiptFromUrl } = require('./lib/receipt');
const { validateReceipt } = require('./lib/validate');
const { saveReceipt } = require('./lib/store');
const { isAllowed } = require('./lib/allowlist');

admin.initializeApp();

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

exports.sms = onRequest(
  { secrets: [twilioAccountSid, twilioAuthToken, twilioPhoneNumber, anthropicApiKey] },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    if (!validateTwilioSignature(req)) {
      return res.status(403).send('Forbidden');
    }

    const from = req.body.From;

    if (!isAllowed(from)) {
      console.warn(`Rejected request from unlisted number: ${from}`);
      return res.type('text/xml').send(twimlResponse('Not authorized.'));
    }

    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    if (numMedia === 0) {
      return res.type('text/xml').send(twimlResponse('Send me a photo of a receipt to log it.'));
    }

    const mediaUrl = req.body.MediaUrl0;
    const contentType = req.body.MediaContentType0 || '';

    if (!contentType.startsWith('image/')) {
      return res.type('text/xml').send(twimlResponse('Please send an image of your receipt.'));
    }

    try {
      const raw = await parseReceiptFromUrl(mediaUrl);
      const receipt = validateReceipt(raw);
      await saveReceipt(receipt, from);

      const merchant = receipt.merchant || 'Unknown';
      const total = receipt.total != null ? `$${receipt.total.toFixed(2)}` : '?';
      const category = receipt.category;

      return res.type('text/xml').send(
        twimlResponse(`Saved: ${merchant} — ${total} (${category})`)
      );
    } catch (err) {
      console.error('Receipt parsing failed:', err);
      return res.type('text/xml').send(
        twimlResponse("Couldn't read that receipt. Try a clearer photo.")
      );
    }
  }
);
