// Only these numbers can submit receipts. Add yours in .env as ALLOWED_PHONES=+16475550123,+14165550456
// Falls back to open if env var is not set (useful for initial testing — lock it down before deploying).

function isAllowed(phoneNumber) {
  const raw = process.env.ALLOWED_PHONES;
  if (!raw) {
    console.warn('ALLOWED_PHONES not set — all numbers allowed. Set this before deploying.');
    return true;
  }
  const allowed = raw.split(',').map(n => n.trim());
  return allowed.includes(phoneNumber);
}

module.exports = { isAllowed };
