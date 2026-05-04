// Only these phone numbers (E.164 format) can submit receipts.
// Set in .env as ALLOWED_PHONES=+14165551234
// Find your number in E.164 format: +1 followed by area code and number, no spaces.
// Falls back to open if env var is not set (useful for initial testing — lock it down before deploying).

function isAllowed(phone) {
  const raw = process.env.ALLOWED_PHONES;
  if (!raw) {
    console.warn('ALLOWED_PHONES not set — all numbers allowed. Set this before deploying.');
    return true;
  }
  const allowed = raw.split(',').map(n => n.trim());
  return allowed.includes(phone);
}

module.exports = { isAllowed };
