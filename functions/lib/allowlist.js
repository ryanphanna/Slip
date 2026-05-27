// Only these phone numbers (E.164 format) can submit receipts.
// Set in .env as ALLOWED_PHONES=+14165551234
// Find your number in E.164 format: +1 followed by area code and number, no spaces.
// Missing allowlist config fails closed.
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { readConfigValue } = require('./runtime-health');

const allowedPhonesSecret = defineSecret('ALLOWED_PHONES');

function normalizePhone(phone) {
  if (typeof phone !== 'string') return '';
  return phone.trim();
}

function isAllowed(phone) {
  const raw = readConfigValue('ALLOWED_PHONES', allowedPhonesSecret).value;
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
