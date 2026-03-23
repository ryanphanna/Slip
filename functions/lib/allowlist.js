// Only these Telegram chat IDs can submit receipts.
// Set in .env as ALLOWED_CHATS=123456789
// Find your chat ID by messaging @userinfobot on Telegram.
// Falls back to open if env var is not set (useful for initial testing — lock it down before deploying).

function isAllowed(chatId) {
  const raw = process.env.ALLOWED_CHATS;
  if (!raw) {
    console.warn('ALLOWED_CHATS not set — all chats allowed. Set this before deploying.');
    return true;
  }
  const allowed = raw.split(',').map(n => n.trim());
  return allowed.includes(chatId);
}

module.exports = { isAllowed };
