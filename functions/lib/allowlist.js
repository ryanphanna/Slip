// Only these phone numbers (E.164 format) can submit receipts.
// Set in .env as ALLOWED_PHONES=+14165551234
// Find your number in E.164 format: +1 followed by area code and number, no spaces.
// Missing allowlist config fails closed.
const logger = require('firebase-functions/logger');

function normalizePhone(phone) {
  if (typeof phone !== 'string') return '';
  return phone.trim();
}

function isAllowed(phone) {
  const raw = process.env.ALLOWED_PHONES;
  if (!raw) {
    logger.error('ALLOWED_PHONES is not set. Rejecting request.');
    return false;
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return false;

  const allowed = new Set(
    raw
      .split(',')
      .map(normalizePhone)
      .filter(Boolean)
  );
  return allowed.has(normalizedPhone);
}

module.exports = { isAllowed };
