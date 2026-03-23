const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { sendMessage, getFileUrl, validateTelegramSecret } = require('./lib/telegram');
const { parseReceiptFromUrl } = require('./lib/receipt');
const { validateReceipt } = require('./lib/validate');
const { saveReceipt } = require('./lib/store');
const { isAllowed } = require('./lib/allowlist');

admin.initializeApp();

const telegramBotToken = defineSecret('TELEGRAM_BOT_TOKEN');
const telegramSecret = defineSecret('TELEGRAM_WEBHOOK_SECRET');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

exports.telegram = onRequest(
  { secrets: [telegramBotToken, telegramSecret, geminiApiKey] },
  async (req, res) => {
    // Always respond 200 immediately — Telegram expects a fast ack
    res.sendStatus(200);

    if (req.method !== 'POST') return;

    if (!validateTelegramSecret(req, telegramSecret.value())) {
      console.warn('Invalid Telegram webhook secret');
      return;
    }

    const update = req.body;
    const message = update.message;
    if (!message) return;

    const chatId = message.chat.id;
    const from = String(chatId);

    if (!isAllowed(from)) {
      console.warn(`Rejected request from unlisted chat: ${chatId}`);
      return;
    }

    // Only handle photo messages
    if (!message.photo) {
      await sendMessage(chatId, 'Send me a photo of a receipt to log it.');
      return;
    }

    // Telegram sends multiple sizes — use the largest
    const photo = message.photo[message.photo.length - 1];

    try {
      const imageUrl = await getFileUrl(photo.file_id);
      const raw = await parseReceiptFromUrl(imageUrl);
      const receipt = validateReceipt(raw);
      await saveReceipt(receipt, from);

      const merchant = receipt.merchant || 'Unknown';
      const total = receipt.total != null ? `$${receipt.total.toFixed(2)}` : '?';
      const category = receipt.category;

      await sendMessage(chatId, `Saved: ${merchant} — ${total} (${category})`);
    } catch (err) {
      console.error('Receipt parsing failed:', err);
      await sendMessage(chatId, "Couldn't read that receipt. Try a clearer photo.");
    }
  }
);
