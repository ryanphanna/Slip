/**
 * Centralized configuration for magic numbers and limits.
 * This makes tuning easier and prevents drift between code and error messages.
 */

module.exports = {
  // === Media & Intake Limits ===
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'],
  MAX_IMAGE_SIZE: 10 * 1024 * 1024,        // 10 MB per image
  MAX_TOTAL_MEDIA_SIZE: 20 * 1024 * 1024,  // 20 MB total across all images in one message
  MAX_MEDIA_ATTACHMENTS: 4,
  MAX_BODY_TEXT_LENGTH: 8000,              // Max characters for pasted receipt text

  // === Rate Limiting ===
  RATE_LIMIT_PER_HOUR: 25,
  RATE_LIMIT_PER_DAY: 100,
  RATE_LIMIT_WINDOW_MS: 60 * 60 * 1000,    // 1 hour


  // === Casual Error Openers ===
  ERROR_OPENERS: ['Uh oh!', 'Whoops!', 'Whoopsie!', 'Shoot!', 'Dang it!', 'Oh no!', 'Yikes!', 'That wasn\'t supposed to happen!'],

  // === Duplicate Detection ===
  DUPLICATE_WINDOW_MS: 10 * 60 * 1000,     // 10 minutes

  // === Cloud Function / Runtime ===
  FUNCTION_TIMEOUT_SECONDS: 180,           // Cloud Run timeout for the sms function
  FETCH_MEDIA_TIMEOUT_MS: 20 * 1000,       // Per-request timeout for Twilio media fetches
  GEMINI_TIMEOUT_MS: 90 * 1000,            // Timeout for each Gemini generateContent call

  // === Storage Routing ===
  STORAGE_PREFIX_TEMPORARY: 'receipts-temporary',
  STORAGE_PREFIX_PERMANENT: 'receipts-permanent',
  PERMANENT_TOTAL_THRESHOLD: 100,
  PERMANENT_CATEGORIES: ['Health', 'Home'],
  PERMANENT_CONFIDENCE_THRESHOLD: 0.8,
  PERMANENT_MERCHANTS: ['ikea'],

  // === Merchant Normalization ===
  MERCHANT_NORMALIZE_MAP: {
    'fresh co': 'FreshCo',
    'freshco': 'FreshCo',
    'whole foods': 'Whole Foods Market',
    'whole foods market': 'Whole Foods Market',
    'trader joe\'s': "Trader Joe's",
    'trader joes': "Trader Joe's",
    'wal-mart': 'Walmart',
    'walbart': 'Walmart',
    'walmart': 'Walmart',
    'tim hortons': 'Tim Hortons',
    't&t supermarket': 'T&T Supermarket',
    'shoppers drug mart': 'Shoppers Drug Mart',
    'ikea': 'IKEA',
    'loblaws': 'Loblaws',
    'old navy': 'Old Navy',
    'uniqlo': 'Uniqlo',
    'superstore': 'Superstore',
    'homesense': 'Homesense',
    'walgreens': 'Walgreens',
    'rexall': 'Rexall',
    'metro': 'Metro',
    'target': 'Target',
  },

  // === Onboarding & Commands ===
  ONBOARDING_KEYWORDS: ['HELLO', 'HI', 'START', 'GET STARTED', 'ONBOARD', 'ONBOARDING', 'HELP', 'WELCOME', 'COMMANDS', 'GUIDE', 'INFO'],
  ONBOARDING_MESSAGE: 'Welcome to Slip! 🧾\nTo log a receipt, just text me a photo of it, or paste the receipt text.\n\nCommands:\n• TOTAL — monthly spend\n• SUMMARY — category breakdown\n• LAST — latest receipt\n• INFO — show commands list',

};
