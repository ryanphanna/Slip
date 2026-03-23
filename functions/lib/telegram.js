const { defineSecret } = require('firebase-functions/params');

const telegramBotToken = defineSecret('TELEGRAM_BOT_TOKEN');

const BASE_URL = () => `https://api.telegram.org/bot${telegramBotToken.value()}`;
const FILE_URL = () => `https://api.telegram.org/file/bot${telegramBotToken.value()}`;

/**
 * Send a text message to a Telegram chat.
 */
async function sendMessage(chatId, text) {
  await fetch(`${BASE_URL()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/**
 * Get the public download URL for a Telegram file by file_id.
 */
async function getFileUrl(fileId) {
  const res = await fetch(`${BASE_URL()}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram getFile failed: ${data.description}`);
  return `${FILE_URL()}/${data.result.file_path}`;
}

/**
 * Validate that the request came from Telegram by checking the secret token header.
 * Set this in your webhook registration: ?secret_token=YOUR_SECRET
 */
function validateTelegramSecret(req, secret) {
  return req.headers['x-telegram-bot-api-secret-token'] === secret;
}

module.exports = { sendMessage, getFileUrl, validateTelegramSecret };
