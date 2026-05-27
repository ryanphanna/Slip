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
  RATE_LIMIT_PER_HOUR: 15,
  RATE_LIMIT_WINDOW_MS: 60 * 60 * 1000,    // 1 hour

  // === Duplicate Detection ===
  DUPLICATE_WINDOW_MS: 10 * 60 * 1000,     // 10 minutes

  // === Cloud Function / Runtime ===
  FUNCTION_TIMEOUT_SECONDS: 180,           // Cloud Run timeout for the sms function
};
