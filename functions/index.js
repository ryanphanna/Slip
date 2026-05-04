const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { validateTwilioSignature, sendSms, fetchMedia } = require('./lib/twilio');
const { parseReceiptFromBase64 } = require('./lib/receipt');
const { validateReceipt } = require('./lib/validate');
const { saveReceipt } = require('./lib/store');
const { isAllowed } = require('./lib/allowlist');

admin.initializeApp();

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

exports.sms = onRequest(
  { secrets: [twilioAccountSid, twilioAuthToken, twilioPhoneNumber, geminiApiKey] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    if (!validateTwilioSignature(req)) {
      console.warn('Invalid Twilio signature');
      res.status(403).send('Forbidden');
      return;
    }

    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const messageSid = req.body.MessageSid;

    if (!isAllowed(from)) {
      console.warn(`Rejected request from unlisted number: ${from}`);
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    if (numMedia === 0) {
      await sendSms(from, 'Send me a photo of a receipt to log it.');
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    // --- Idempotency: skip if this MessageSid was already processed ---
    if (messageSid) {
      const db = admin.firestore();
      const existing = await db.collection('receipts').where('messageSid', '==', messageSid).limit(1).get();
      if (!existing.empty) {
        console.log(`Duplicate MessageSid ${messageSid} — skipping`);
        res.set('Content-Type', 'text/xml');
        res.send('<Response/>');
        return;
      }
    }

    // --- Image validation: reject non-image MIME types ---
    const mimeType = req.body.MediaContentType0 || 'image/jpeg';
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType.toLowerCase())) {
      console.warn(`Rejected non-image MIME type: ${mimeType}`);
      await sendSms(from, `That doesn't look like an image (${mimeType}). Send a photo of a receipt.`);
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    const mediaUrl = req.body.MediaUrl0;

    try {
      const imgResponse = await fetchMedia(mediaUrl);

      // Check file size before buffering
      const contentLength = parseInt(imgResponse.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_IMAGE_SIZE) {
        console.warn(`Image too large: ${contentLength} bytes`);
        await sendSms(from, 'That image is too large. Try a smaller photo.');
        res.set('Content-Type', 'text/xml');
        res.send('<Response/>');
        return;
      }

      const buffer = await imgResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const raw = await parseReceiptFromBase64(base64, mimeType);
      const receipt = validateReceipt(raw);
      await saveReceipt(receipt, from, messageSid);

      const merchant = receipt.merchant || 'Unknown';
      const total = receipt.total != null ? `$${receipt.total.toFixed(2)}` : '?';
      const category = receipt.category;

      await sendSms(from, `Saved: ${merchant} — ${total} (${category})`);
    } catch (err) {
      console.error('Receipt parsing failed:', err);
      await sendSms(from, "Couldn't read that receipt. Try a clearer photo.");
    }

    // Acknowledge Twilio after all work is done
    res.set('Content-Type', 'text/xml');
    res.send('<Response/>');
  }
);
