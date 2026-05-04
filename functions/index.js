const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { validateTwilioSignature, sendSms, fetchMedia } = require('./lib/twilio');
const { parseReceiptFromBase64, parseReceiptFromText } = require('./lib/receipt');
const { validateReceipt } = require('./lib/validate');
const { saveReceipt } = require('./lib/store');
const { saveImages } = require('./lib/image-store');
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

    try {
      let raw;
      if (numMedia === 0) {
        const bodyText = (req.body.Body || '').trim();
        if (!bodyText) {
          await sendSms(from, 'Send me a photo or paste text of a receipt to log it.');
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        raw = await parseReceiptFromText(bodyText);
      } else {
        const images = [];
        for (let i = 0; i < numMedia; i++) {
          const mimeType = req.body[`MediaContentType${i}`] || 'image/jpeg';
          if (!ALLOWED_IMAGE_TYPES.includes(mimeType.toLowerCase())) continue;

          const mediaUrl = req.body[`MediaUrl${i}`];
          const imgResponse = await fetchMedia(mediaUrl);

          const contentLength = parseInt(imgResponse.headers.get('content-length') || '0', 10);
          if (contentLength > MAX_IMAGE_SIZE) continue;

          const buffer = await imgResponse.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          images.push({ base64, mimeType });
        }

        if (images.length === 0) {
          await sendSms(from, 'None of the attachments were valid images. Try again.');
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        raw = await parseReceiptFromBase64(images);
      }

      // Store images non-blocking — a storage failure shouldn't kill the receipt save
      let imagePaths = [];
      if (images.length > 0) {
        try {
          imagePaths = await saveImages(images, messageSid);
        } catch (err) {
          console.error('Image storage failed (non-fatal):', err.message);
        }
      }

      const receipt = validateReceipt(raw);
      await saveReceipt(receipt, from, messageSid, imagePaths);

      const merchant = receipt.merchant || 'Unknown';
      const total = receipt.total != null ? `$${Math.abs(receipt.total).toFixed(2)}` : '?';
      const categoryDisplay = receipt.subCategory ? `${receipt.category}: ${receipt.subCategory}` : receipt.category;
      const prefix = receipt.type === 'refund' ? 'Saved Refund' : 'Saved';

      await sendSms(from, `${prefix}: ${merchant} — ${total} (${categoryDisplay})`);
    } catch (err) {
      console.error('Receipt parsing failed:', err);
      await sendSms(from, `Couldn't read that receipt. Error: ${err.message}`);
    }

    // Acknowledge Twilio after all work is done
    res.set('Content-Type', 'text/xml');
    res.send('<Response/>');
  }
);
