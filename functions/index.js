const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Polyfill firebase-admin v14 top-level service getters for compatibility
if (!admin.firestore) {
  const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
  admin.firestore = getFirestore;
  admin.firestore.FieldValue = FieldValue;
  admin.firestore.Timestamp = Timestamp;
}
if (!admin.auth) {
  // Lazy: firebase-admin/auth pulls in ESM-only deps that break Jest at load time.
  admin.auth = (...args) => require('firebase-admin/auth').getAuth(...args);
}
if (!admin.storage) {
  const { getStorage } = require('firebase-admin/storage');
  admin.storage = getStorage;
}

const { validateTwilioSignature, sendSms } = require('./lib/twilio');
const { isMessageProcessed, checkRateLimit } = require('./lib/store');
const { getMonthlyStats, getSpendingStats, getLastReceipt } = require('./lib/query');
const { isAllowed } = require('./lib/allowlist');
const { setBudget, getBudgetReport, getBudgetStatus } = require('./lib/budget');
const { resolveCategory, isSpendingCategory, SPENDING_CATEGORIES } = require('./lib/categories');
const { formatMoney, alsoSpentLine, currencyOf } = require('./lib/money');
const { processReceiptMessage } = require('./lib/sms-receipt');
const { sendMonthlyDigest, sendWeeklyBudgetCheck } = require('./lib/digest');
const { summarizeRuntimeHealth } = require('./lib/runtime-health');
const webApi = require('./lib/web-api');
const { handleMcp } = require('./lib/mcp');
const { purgeOldFailures } = require('./lib/retention');
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

    // Fail open like the rate limit: a Firestore hiccup must not hang the request.
    // Duplicates are still caught later by the saved-receipt duplicate check.
    let alreadyProcessed = false;
    try {
      alreadyProcessed = await isMessageProcessed(messageSid);
    } catch (err) {
      logger.error('isMessageProcessed failed, continuing without idempotency check', { messageSid, error: err.message });
    }
    if (alreadyProcessed) {
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
          const alsoSpent = alsoSpentLine(stats.byCurrency);
          let message = `${label}: $${stats.total.toFixed(2)} (${stats.count} ${receiptWord})${alsoSpent ? `\n${alsoSpent}` : ''}${hint}`;

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
          const alsoSpent = alsoSpentLine(stats.byCurrency);
          await sendSms(from, `${stats.month} Summary:\n${breakdown}\n\nTotal: $${stats.total.toFixed(2)}${alsoSpent ? `\n\n${alsoSpent}` : ''}`);
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
            await sendSms(from, `Last: ${last.merchant} — ${formatMoney(last.total || 0, currencyOf(last))} on ${date} (${last.category})`);
          }
          res.set('Content-Type', 'text/xml');
          res.send('<Response/>');
          return;
        }

        if (bodyText === 'BUDGET') {
          const { report, otherSpend } = await getBudgetStatus(from);
          const activeBudgets = report.filter(r => r.limit > 0);
          if (activeBudgets.length === 0) {
            await sendSms(from, 'No active budgets. Set one via: BUDGET <category> <limit>');
          } else {
            const lines = activeBudgets
              .map(r => `${r.category}: $${r.spent.toFixed(2)} / $${r.limit.toFixed(2)} (${r.percentage}%)`)
              .join('\n');
            const alsoSpent = alsoSpentLine(otherSpend, { note: 'not counted in budgets' });
            await sendSms(from, `Monthly Budgets:\n${lines}${alsoSpent ? `\n\n${alsoSpent}` : ''}`);
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
            const typedCategory = parts.slice(1, -1).join(' ');
            const category = resolveCategory(typedCategory);
            if (!category) {
              await sendSms(from, `${oops()} I don't know the category "${typedCategory}". Use one of: ${SPENDING_CATEGORIES.join(', ')}.`);
            } else if (!isSpendingCategory(category)) {
              await sendSms(from, `${category} isn't counted as spending, so it can't have a budget. Use one of: ${SPENDING_CATEGORIES.join(', ')}.`);
            } else {
              await setBudget(from, category, limit);
              await sendSms(from, `Budget set: ${category} limit is now $${limit.toFixed(2)}.`);
            }
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
      processReceiptMessage({ body: req.body, from, maskedFrom, messageSid, numMedia });
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

// Daily cleanup of finished processing failures (and their now-unused images).
// Dry-run by default: set FAILURE_RETENTION_DRY_RUN=false to actually delete.
const failureRetentionDryRun = defineString('FAILURE_RETENTION_DRY_RUN', { default: 'true' });
exports.purgeOldFailures = onSchedule(
  { schedule: '30 3 * * *', timeZone: 'America/Toronto', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const dryRun = failureRetentionDryRun.value() !== 'false';
    try {
      const counts = await purgeOldFailures({ dryRun });
      logger.info('Failure retention run', counts);
    } catch (error) {
      logger.error('Failure retention run failed', { error: error.message });
    }
  }
);

// Browser API. Firestore and Storage remain server-only; every operation is
// scoped to the verified phone number in the Firebase Auth token.
// Callables read ALLOWED_PHONES (via requireAuth), so every one must bind the secret.
function callable(handler, options = {}) {
  const wrapped = async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const code = ['unauthenticated', 'not-found', 'invalid-argument', 'permission-denied', 'failed-precondition', 'resource-exhausted'].includes(error.code)
        ? error.code
        : 'internal';
      throw new HttpsError(code, error.message || 'Request failed');
    }
  };
  return onCall({ ...options, secrets: [allowedPhonesSecret] }, wrapped);
}

exports.listReceipts = callable(webApi.listReceipts);
exports.getReceipt = callable(webApi.getReceipt);
exports.updateReceipt = callable(webApi.updateReceipt);
exports.listFlaggedReceipts = callable(webApi.listFlaggedReceipts);
exports.getReceiptImageUrls = callable(webApi.getReceiptImageUrls);
exports.listProcessingFailures = callable(webApi.listProcessingFailures);
exports.listNotifications = callable(webApi.listNotifications);
exports.getMonthlyRecap = callable(webApi.getMonthlyRecap);
exports.getPoints = callable(webApi.getPoints);
exports.getProcessingFailureImageUrls = callable(webApi.getProcessingFailureImageUrls);
// Gemini parsing can take up to GEMINI_TIMEOUT_MS per attempt; keep well above the default.
exports.retryProcessing = callable(webApi.retryProcessing, { timeoutSeconds: config.FUNCTION_TIMEOUT_SECONDS });
exports.importTargetReceipts = callable(webApi.importTargetReceipts);
exports.listItems = callable(webApi.listItems);
exports.updateItem = callable(webApi.updateItem);
exports.getSettings = callable(webApi.getUserSettings);
exports.updateSettings = callable(webApi.updateUserSettings);
exports.createImportToken = callable(webApi.createImportToken);
exports.listImportTokens = callable(webApi.listImportTokens);
exports.revokeImportToken = callable(webApi.revokeImportToken);

// Remote MCP endpoint for user-owned AI assistants. Write-only create_receipt;
// no Gemini secret is bound, so this path cannot make Gemini calls.
// One request at a time on one instance keeps the hourly rate-limit count race-free.
exports.mcp = onRequest({ memory: '256MiB', concurrency: 1, maxInstances: 1, secrets: [allowedPhonesSecret] }, async (req, res) => {
  try {
    const rawLength = Number(req.headers['content-length']) || (req.rawBody ? req.rawBody.length : 0);
    const result = await handleMcp({ method: req.method, headers: req.headers, body: req.body, rawLength });
    for (const [key, value] of Object.entries(result.headers || {})) res.set(key, value);
    if (result.body === null) return res.status(result.status).end();
    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error('MCP handler failed', { error: error.message });
    return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
  }
});
