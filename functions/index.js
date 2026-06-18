const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { validateTwilioSignature, sendSms, fetchMedia } = require('./lib/twilio');
const { parseReceiptFromBase64, parseReceiptFromText } = require('./lib/receipt');
const { validateReceipt } = require('./lib/validate');
const { saveReceipt, findDuplicate, isMessageProcessed, checkRateLimit } = require('./lib/store');
const { getMonthlyStats, getLastReceipt } = require('./lib/query');
const { saveImages } = require('./lib/image-store');
const { isAllowed } = require('./lib/allowlist');
const { setBudget, getBudget, getBudgetReport } = require('./lib/budget');
const { summarizeRuntimeHealth } = require('./lib/runtime-health');
const config = require('./lib/config');

admin.initializeApp();

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const twilioPhoneNumber = defineSecret('TWILIO_PHONE_NUMBER');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const allowedPhonesSecret = defineSecret('ALLOWED_PHONES');
const webhookUrlSecret = defineSecret('WEBHOOK_URL');

let startupHealthLogged = false;

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return 'unknown';
  const clean = phone.trim();
  if (clean.length <= 4) return clean;
  return `+${'*'.repeat(clean.length - 5)}${clean.slice(-4)}`;
}

exports.sms = onRequest(
  {
    secrets: [
      twilioAccountSid,
      twilioAuthToken,
      twilioPhoneNumber,
      geminiApiKey,
      allowedPhonesSecret,
      webhookUrlSecret,
    ],
    timeoutSeconds: config.FUNCTION_TIMEOUT_SECONDS,
  },
  async (req, res) => {
    if (!startupHealthLogged) {
      logger.info('Startup runtime health', summarizeRuntimeHealth({
        twilioAccountSid,
        twilioAuthToken,
        twilioPhoneNumber,
        geminiApiKey,
        allowedPhones: allowedPhonesSecret,
        webhookUrl: webhookUrlSecret,
      }));
      startupHealthLogged = true;
    }

    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    if (!req.body || typeof req.body !== 'object') {
      res.status(400).send('Bad Request');
      return;
    }

    const from = req.body.From;
    const maskedFrom = maskPhone(from);
    const numMedia = Number.parseInt(req.body.NumMedia || '0', 10);
    const messageSid = req.body.MessageSid;

    if (!from || typeof from !== 'string') {
      logger.warn('Rejected request with missing From value', { messageSid });
      res.status(400).send('Bad Request');
      return;
    }

    if (!Number.isFinite(numMedia) || numMedia < 0) {
      logger.warn('Rejected request with invalid NumMedia', { messageSid, numMedia: req.body.NumMedia });
      res.status(400).send('Bad Request');
      return;
    }

    const allowedSender = isAllowed(from);
    const signatureValid = validateTwilioSignature(req);

    if (!signatureValid) {
      logger.warn('Invalid Twilio signature', {
        messageSid,
        from: maskedFrom,
        allowedSender,
      });
      if (!allowedSender) {
        res.status(403).send('Forbidden');
        return;
      }
    }

    if (!allowedSender) {
      logger.warn('Rejected request from unlisted number', { messageSid, from: maskedFrom });
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    if (await isMessageProcessed(messageSid)) {
      logger.info('Message already processed (idempotency)', { messageSid });
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    if (await checkRateLimit(from)) {
      logger.warn('Rate limit exceeded', { messageSid, from: maskedFrom });
      await sendSms(from, 'Hourly limit reached. Please wait a bit before logging more receipts.');
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    if (numMedia > config.MAX_MEDIA_ATTACHMENTS) {
      await sendSms(from, `Too many attachments. Send up to ${config.MAX_MEDIA_ATTACHMENTS} images per message.`);
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    try {
      // Handle Text Commands
      if (numMedia === 0) {
        const bodyText = (req.body.Body || '').trim().toUpperCase();
        
        if (bodyText === 'TOTAL') {
          const stats = await getMonthlyStats(from);
          await sendSms(from, `${stats.month} Total: $${stats.total.toFixed(2)} (${stats.count} receipts)`);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (bodyText === 'SUMMARY') {
          const stats = await getMonthlyStats(from);
          const breakdown = Object.entries(stats.categories)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, amt]) => `${cat}: $${amt.toFixed(2)}`)
            .join('\n');
          await sendSms(from, `${stats.month} Summary:\n${breakdown}\n\nTotal: $${stats.total.toFixed(2)}`);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (bodyText === 'LAST') {
          const last = await getLastReceipt(from);
          if (!last) {
            await sendSms(from, 'No receipts found.');
          } else {
            const date = last.date || 'unknown date';
            await sendSms(from, `Last: ${last.merchant} — $${(last.total || 0).toFixed(2)} on ${date} (${last.category})`);
          }
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (bodyText === 'BUDGET') {
          const report = await getBudgetReport(from);
          const activeBudgets = report.filter(r => r.limit > 0);
          if (activeBudgets.length === 0) {
            await sendSms(from, 'No active budgets. Set one via: BUDGET <category> <limit>');
          } else {
            const lines = activeBudgets
              .map(r => `${r.category}: $${r.spent.toFixed(2)} / $${r.limit.toFixed(2)} (${r.percentage}%)`)
              .join('\n');
            await sendSms(from, `Monthly Budgets:\n${lines}`);
          }
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (bodyText.startsWith('BUDGET ')) {
          const parts = (req.body.Body || '').trim().split(/\s+/);
          const limitStr = parts[parts.length - 1];
          const limit = parseFloat(limitStr);

          if (parts.length >= 3 && !isNaN(limit) && limit >= 0) {
            const category = parts.slice(1, -1).join(' ');
            await setBudget(from, category, limit);
            await sendSms(from, `Budget set: ${category} limit is now $${limit.toFixed(2)}.`);
          } else {
            await sendSms(from, 'Invalid syntax. Use: BUDGET <category> <limit> (e.g., BUDGET Grocery 500)');
          }
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (config.ONBOARDING_KEYWORDS.includes(bodyText)) {
          await sendSms(from, config.ONBOARDING_MESSAGE);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }
      }

      let raw;
      const images = [];
      if (numMedia === 0) {
        const bodyText = (req.body.Body || '').trim();
        if (!bodyText) {
          await sendSms(from, 'Send me a photo or paste text of a receipt to log it.');
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (bodyText.length > config.MAX_BODY_TEXT_LENGTH) {
          await sendSms(from, `Receipt text is too long. Keep it under ${config.MAX_BODY_TEXT_LENGTH} characters.`);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        raw = await parseReceiptFromText(bodyText);
      } else {
        let totalMediaBytes = 0;
        for (let i = 0; i < numMedia; i++) {
          const mimeType = req.body[`MediaContentType${i}`] || 'image/jpeg';
          if (!config.ALLOWED_IMAGE_TYPES.includes(mimeType.toLowerCase())) continue;

          const mediaUrl = req.body[`MediaUrl${i}`];
          if (!mediaUrl) continue;
          const imgResponse = await fetchMedia(mediaUrl);

          const contentLength = Number.parseInt(imgResponse.headers.get('content-length') || '0', 10);
          if (contentLength > config.MAX_IMAGE_SIZE) continue;

          const buffer = Buffer.from(await imgResponse.arrayBuffer());
          if (buffer.length > config.MAX_IMAGE_SIZE) continue;

          if (totalMediaBytes + buffer.length > config.MAX_TOTAL_MEDIA_SIZE) continue;
          totalMediaBytes += buffer.length;

          const base64 = buffer.toString('base64');
          images.push({ base64, mimeType });
        }

        if (images.length === 0) {
          await sendSms(from, `No valid images were found. Use up to ${config.MAX_MEDIA_ATTACHMENTS} images under ${config.MAX_IMAGE_SIZE / 1024 / 1024}MB each.`);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        raw = await parseReceiptFromBase64(images);
      }

      const receipt = validateReceipt(raw);

      // Store images non-blocking — a storage failure shouldn't kill the receipt save
      let imagePaths = [];
      if (images.length > 0) {
        try {
          imagePaths = await saveImages(images, messageSid, receipt);
        } catch (err) {
          logger.error('Image storage failed (non-fatal)', { messageSid, error: err.message });
        }
      }
      
      const duplicateId = await findDuplicate(receipt, from);
      if (duplicateId) {
        logger.info('Duplicate receipt detected, skipping save', { messageSid, from: maskedFrom, duplicateId });
        await sendSms(from, `Duplicate: ${receipt.merchant} — $${Math.abs(receipt.total).toFixed(2)} was already logged recently.`);
        res.set('Content-Type', 'text/xml');
        res.send('<Response/>');
        return;
      }

      await saveReceipt(receipt, from, messageSid, imagePaths);

      const merchant = receipt.merchant || 'Unknown';
      const total = receipt.total != null ? `$${Math.abs(receipt.total).toFixed(2)}` : '?';
      const categoryDisplay = receipt.subCategory ? `${receipt.category}: ${receipt.subCategory}` : receipt.category;
      const prefix = receipt.type === 'refund' ? 'Saved Refund' : 'Saved';
      const itemCount = Array.isArray(receipt.items) ? receipt.items.length : 0;
      const itemSuffix = itemCount === 1 ? '1 item' : `${itemCount} items`;
      
      let message = `${prefix}: ${merchant} — ${total} (${categoryDisplay}, ${itemSuffix})`;
      
      // Warn if confidence is still low after potential fallback
      if (raw.confidence != null && raw.confidence < 0.7) {
        message = `⚠️ ${message}`;
        logger.warn('Low confidence receipt saved', { messageSid, confidence: raw.confidence, merchant });
      }

      // Budget status integration
      if (receipt.category) {
        try {
          const budget = await getBudget(from, receipt.category);
          if (budget && budget.limit > 0) {
            const db = admin.firestore();
            const now = new Date();
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            
            const snapshot = await db.collection('receipts')
              .where('from', '==', from)
              .where('createdAt', '>=', startOfMonth)
              .get();

            let spent = 0;
            const categoryLower = receipt.category.toLowerCase();
            snapshot.forEach(doc => {
              const data = doc.data();
              if (data.category?.toLowerCase() === categoryLower && data.total != null) {
                spent += data.total;
              }
            });

            spent = Math.round(spent * 100) / 100;
            const remaining = Math.round((budget.limit - spent) * 100) / 100;
            const budgetLine = `\nBudget: $${spent.toFixed(2)}/$${budget.limit.toFixed(2)} spent`;

            if (spent > budget.limit) {
              message += `${budgetLine} (⚠️ over by $${Math.abs(remaining).toFixed(2)})`;
            } else {
              message += `${budgetLine} ($${remaining.toFixed(2)} left)`;
            }
          }
        } catch (budgetErr) {
          logger.error('Failed to append budget status to receipt confirmation', { messageSid, error: budgetErr.message });
        }
      }

      await sendSms(from, message);
      logger.info('Successfully processed receipt', { messageSid, from: maskedFrom, merchant, total, confidence: raw.confidence });
    } catch (err) {
      logger.error('Receipt processing failed', {
        messageSid,
        from: maskedFrom,
        error: err && err.message ? err.message : err,
        cause: err && err.cause && err.cause.message ? err.cause.message : undefined,
      });

      try {
        const lastReceipt = await getLastReceipt(from);
        if (!lastReceipt) {
          await sendSms(from, config.ONBOARDING_MESSAGE);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }
      } catch (dbErr) {
        logger.error('Failed to query last receipt for onboarding check', { messageSid, error: dbErr.message });
      }

      const errorMessage = err && err.message ? err.message : 'Unknown error';
      const safeMessage = errorMessage.replace(/\s+/g, ' ').slice(0, 140);
      await sendSms(from, `Couldn't read that receipt. ${safeMessage}. Try again with a clearer image or shorter text.`);
    }

    // Acknowledge Twilio after all work is done
    res.set('Content-Type', 'text/xml');
    res.send('<Response/>');
  }
);
