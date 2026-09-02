const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Polyfill firebase-admin v14 top-level service getters for compatibility
if (!admin.firestore) {
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  admin.firestore = getFirestore;
  admin.firestore.FieldValue = FieldValue;
}
if (!admin.storage) {
  const { getStorage } = require('firebase-admin/storage');
  admin.storage = getStorage;
}

const { validateTwilioSignature, sendSms, fetchMedia } = require('./lib/twilio');
const { parseReceiptFromBase64, parseReceiptFromText } = require('./lib/receipt');
const { validateReceipt } = require('./lib/validate');
const { saveReceipt, saveProcessingFailure, findDuplicate, isMessageProcessed, checkRateLimit } = require('./lib/store');
const { getMonthlyStats, getSpendingStats, getLastReceipt, aggregateSpendingByCategory } = require('./lib/query');
const { saveImages, saveFailedImages } = require('./lib/image-store');
const { isAllowed } = require('./lib/allowlist');
const { setBudget, getBudget, getBudgetReport } = require('./lib/budget');
const { sendMonthlyDigest, sendWeeklyBudgetCheck } = require('./lib/digest');
const { summarizeRuntimeHealth } = require('./lib/runtime-health');
const webApi = require('./lib/web-api');
const config = require('./lib/config');

const oops = () => config.ERROR_OPENERS[Math.floor(Math.random() * config.ERROR_OPENERS.length)];

admin.initializeApp({
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'slip-c742b.firebasestorage.app',
});

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
    memory: '512MiB',
    concurrency: 1,
    minInstances: 1,
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
      logger.warn('Unauthorized Twilio webhook request', {
        messageSid,
        from: maskedFrom,
        allowedSender,
      });
      res.status(403).send('Forbidden');
      return;
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

    const rateLimit = await checkRateLimit(from).catch(err => {
      logger.error('checkRateLimit failed, allowing request', { messageSid, error: err.message });
      return null;
    });
    if (rateLimit && (rateLimit === true || rateLimit.exceeded)) {
      const reason = rateLimit.reason || 'hourly';
      logger.warn('Rate limit exceeded', { messageSid, from: maskedFrom, reason });
      const msg = reason === 'daily'
        ? `${oops()} You've hit your daily limit (${config.RATE_LIMIT_PER_DAY} receipts). Come back tomorrow!`
        : `${oops()} Slow down! You've hit the hourly limit (${config.RATE_LIMIT_PER_HOUR} receipts/hr). Try again in a bit.`;
      await sendSms(from, msg);
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }


    if (numMedia > config.MAX_MEDIA_ATTACHMENTS) {
      await sendSms(from, `${oops()} I can only handle ${config.MAX_MEDIA_ATTACHMENTS} photos at a time. Try sending one receipt at a time.`);
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');
      return;
    }

    // Handle Text Commands
    if (numMedia === 0) {
        const bodyText = (req.body.Body || '').trim().toUpperCase();
        
        if (bodyText === 'TOTAL' || bodyText.startsWith('TOTAL ')) {
          const now = new Date();
          let startDate = null;
          let label = 'All Time';

          if (bodyText === 'TOTAL MONTH') {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            label = now.toLocaleString('default', { month: 'long' });
          } else if (bodyText === 'TOTAL YEAR') {
            startDate = new Date(now.getFullYear(), 0, 1);
            label = String(now.getFullYear());
          } else {
            // TOTAL or TOTAL 30 → last 30 days
            startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            label = 'Last 30 days';
          }

          const stats = await getSpendingStats(from, startDate);
          const receiptWord = stats.count === 1 ? 'receipt' : 'receipts';
          const hint = bodyText === 'TOTAL' ? '\n\nSend TOTAL MONTH or TOTAL YEAR for other ranges.' : '';
          let message = `${label}: $${stats.total.toFixed(2)} (${stats.count} ${receiptWord})${hint}`;

          try {
            const report = await getBudgetReport(from);
            if (Array.isArray(report)) {
              const activeBudgets = report.filter(r => r.limit > 0);
              if (activeBudgets.length === 0) {
                message += '\n\n💡 Tip: Send BUDGET Grocery 500 to set category-specific budgets.';
              }
            }
          } catch (budgetErr) {
            logger.error('Failed to fetch budget report for tip check', { error: budgetErr.message });
          }

          await sendSms(from, message);
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
            await sendSms(from, `${oops()} That didn't look right. Try: BUDGET <category> <limit> (e.g., BUDGET Grocery 500)`);
          }
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (config.GREETING_KEYWORDS.includes(bodyText)) {
          await sendSms(from, config.ONBOARDING_MESSAGE);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (config.COMMAND_KEYWORDS.includes(bodyText)) {
          await sendSms(from, config.COMMANDS_MESSAGE);
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }
      }

      // ACK Twilio immediately — receipt parsing (Gemini) can exceed the 15s webhook
      // timeout. Processing continues in the background; result arrives via sendSms.
      res.set('Content-Type', 'text/xml');
      res.send('<Response/>');

      // --- background processing starts here ---
      const images = [];
      let storedImagePaths = [];
      (async () => {
        let isFirstReceipt = false;
        try {
          const lastReceipt = await getLastReceipt(from);
          isFirstReceipt = !lastReceipt;
        } catch (dbErr) {
          logger.error('Failed to query last receipt for first receipt check', { messageSid, error: dbErr.message });
        }

        let raw;
        if (numMedia === 0) {
          const bodyText = (req.body.Body || '').trim();
          if (!bodyText) {
            await sendSms(from, 'Send me a photo or paste text of a receipt to log it.');
            return;
          }

          if (bodyText.length > config.MAX_BODY_TEXT_LENGTH) {
            await sendSms(from, `${oops()} That's a lot of text! Try pasting just the key lines from the receipt.`);
            return;
          }

          raw = await parseReceiptFromText(bodyText, isFirstReceipt);

          const extractedNothing = raw.merchant == null && raw.total == null &&
            (!Array.isArray(raw.items) || raw.items.length === 0);
          if (extractedNothing) {
            logger.info('Text message did not look like a receipt, skipping save', { messageSid });
            await sendSms(from, "That didn't look like a receipt. Send INFO for commands.");
            return;
          }
        } else {
          const mediaPromises = [];
          for (let i = 0; i < numMedia; i++) {
            const mimeType = req.body[`MediaContentType${i}`] || 'image/jpeg';
            const mediaUrl = req.body[`MediaUrl${i}`];
            if (config.ALLOWED_IMAGE_TYPES.includes(mimeType.toLowerCase()) && mediaUrl) {
              mediaPromises.push((async () => {
                const imgResponse = await fetchMedia(mediaUrl);
                const contentLength = Number.parseInt(imgResponse.headers.get('content-length') || '0', 10);
                if (contentLength > config.MAX_IMAGE_SIZE) return null;

                const buffer = Buffer.from(await imgResponse.arrayBuffer());
                if (buffer.length > config.MAX_IMAGE_SIZE) return null;

                return { buffer, mimeType };
              })());
            }
          }

          const fetchedMedia = (await Promise.all(mediaPromises)).filter(Boolean);
          let totalMediaBytes = 0;
          for (const item of fetchedMedia) {
            if (totalMediaBytes + item.buffer.length <= config.MAX_TOTAL_MEDIA_SIZE) {
              totalMediaBytes += item.buffer.length;
              images.push({ base64: item.buffer.toString('base64'), mimeType: item.mimeType });
            }
          }

          if (images.length === 0) {
            await sendSms(from, `${oops()} I couldn't read that photo. Try sending a clearer image, one receipt at a time.`);
            return;
          }

          raw = await parseReceiptFromBase64(images, undefined, isFirstReceipt);
        }

        const receipt = validateReceipt(raw);
        if (raw.confidence != null) receipt.confidence = raw.confidence;

        // Store images and check for duplicates in parallel to optimize latency
        const [imagePathsResult, duplicateId] = await Promise.all([
          images.length > 0
            ? saveImages(images, messageSid, receipt).catch(err => {
                logger.error('Image storage failed (non-fatal)', { messageSid, error: err.message });
                return [];
              })
            : Promise.resolve([]),
          findDuplicate(receipt, from)
        ]);

        const imagePaths = imagePathsResult;
        storedImagePaths = imagePaths;
        if (duplicateId) {
          logger.info('Duplicate receipt detected, skipping save', { messageSid, from: maskedFrom, duplicateId });
          await sendSms(from, `Duplicate: ${receipt.merchant} — $${Math.abs(receipt.total).toFixed(2)} was already logged.`);
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

        if (raw.confidence != null && raw.confidence < 0.7) {
          message = `⚠️ ${message}`;
          logger.warn('Low confidence receipt saved', { messageSid, confidence: raw.confidence, merchant });
        }

        if (!receipt.date) {
          message += '\n\nCouldn\'t find a date on this one — re-send if it matters.';
          logger.warn('Receipt saved with no date', { messageSid, merchant });
        }

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

              const docs = snapshot.docs.map(doc => doc.data());
              const { categories } = aggregateSpendingByCategory(docs);
              const spentKey = Object.keys(categories).find(k => k.toLowerCase() === receipt.category.toLowerCase());
              const spent = spentKey ? categories[spentKey] : 0;

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

        if (isFirstReceipt) {
          message += '\n\n💡 Tip: Send TOTAL to see your monthly spend, or INFO for all commands.';
        }

        await sendSms(from, message);
        logger.info('Successfully processed receipt', { messageSid, from: maskedFrom, merchant, total, confidence: raw.confidence });
      })().catch(async (err) => {
        logger.error('Receipt processing failed', {
          messageSid,
          from: maskedFrom,
          error: err && err.message ? err.message : err,
          cause: err && err.cause && err.cause.message ? err.cause.message : undefined,
        });

        let failureImagePaths = storedImagePaths;
        if (images.length > 0 && failureImagePaths.length === 0) {
          try {
            failureImagePaths = await saveFailedImages(images, messageSid);
          } catch (storageErr) {
            logger.error('Failed to preserve images for processing failure', { messageSid, error: storageErr.message });
          }
        }

        try {
          await saveProcessingFailure({
            from,
            messageSid,
            error: err && err.message ? err.message : String(err),
            imagePaths: failureImagePaths,
            numMedia,
          });
        } catch (failureErr) {
          logger.error('Failed to save processing failure record', { messageSid, error: failureErr.message });
        }

        try {
          const lastReceipt = await getLastReceipt(from);
          if (!lastReceipt) {
            await sendSms(from, config.ONBOARDING_MESSAGE);
            return;
          }
        } catch (dbErr) {
          logger.error('Failed to query last receipt for onboarding check', { messageSid, error: dbErr.message });
        }

        await Promise.resolve(sendSms(from, `${oops()} Couldn't read that receipt. Try again with a clearer image or shorter text.`)).catch(() => {});
      });
  }
);

const SCHEDULED_SECRETS = [twilioAccountSid, twilioAuthToken, twilioPhoneNumber, allowedPhonesSecret];

function parseAllowedPhones() {
  return (allowedPhonesSecret.value() || '').split(',').map(p => p.trim()).filter(Boolean);
}

exports.monthlyDigest = onSchedule(
  { schedule: '0 9 1 * *', timeZone: 'America/Toronto', secrets: SCHEDULED_SECRETS },
  async () => {
    const phones = parseAllowedPhones();
    const results = await Promise.allSettled(phones.map(p => sendMonthlyDigest(p)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') logger.error('Monthly digest failed', { phone: phones[i], error: r.reason?.message });
    });
  }
);

exports.weeklyBudgetCheck = onSchedule(
  { schedule: '0 18 * * 0', timeZone: 'America/Toronto', secrets: SCHEDULED_SECRETS },
  async () => {
    const phones = parseAllowedPhones();
    const results = await Promise.allSettled(phones.map(p => sendWeeklyBudgetCheck(p)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') logger.error('Weekly budget check failed', { phone: phones[i], error: r.reason?.message });
    });
  }
);

// Browser API. Firestore and Storage remain server-only; every operation is
// scoped to the verified phone number in the Firebase Auth token.
function callable(handler) {
  return onCall(async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const code = ['unauthenticated', 'not-found', 'invalid-argument', 'permission-denied'].includes(error.code)
        ? error.code
        : 'internal';
      throw new HttpsError(code, error.message || 'Request failed');
    }
  });
}

exports.listReceipts = callable(webApi.listReceipts);
exports.getReceipt = callable(webApi.getReceipt);
exports.updateReceipt = callable(webApi.updateReceipt);
exports.getReceiptImageUrls = callable(webApi.getReceiptImageUrls);
exports.listProcessingFailures = callable(webApi.listProcessingFailures);
exports.listNotifications = callable(webApi.listNotifications);
exports.getProcessingFailureImageUrls = callable(webApi.getProcessingFailureImageUrls);
exports.retryProcessing = callable(webApi.retryProcessing);
exports.importTargetReceipts = callable(webApi.importTargetReceipts);
exports.listItems = callable(webApi.listItems);
exports.updateItem = callable(webApi.updateItem);
exports.getSettings = callable(webApi.getUserSettings);
exports.updateSettings = callable(webApi.updateUserSettings);
