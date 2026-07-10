const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const geminiApiKey = defineSecret('GEMINI_API_KEY');

// Delegate all heavy Gemini logic to the shared module.
// This eliminates duplication with test scripts while keeping the
// exact same public API for existing callers (index.js, etc.).
const {
  PROMPT,
  parseReceiptFromBase64: _parseBase64,
  parseReceiptFromText: _parseText,
  parseReceiptFromUrl: _parseUrl,
} = require('./gemini');

/**
 * Thin wrapper that resolves the Firebase secret before calling the shared implementation.
 * Preserves the legacy 2-arg call style (base64String, mimeType) used by replay.js.
 */
async function parseReceiptFromBase64(images, mimeType, forcePro = false) {
  const apiKey = geminiApiKey.value();

  try {
    let arg = images;
    let actualForcePro = forcePro;
    if (typeof images === 'string' && mimeType) {
      if (typeof mimeType === 'boolean') {
        actualForcePro = mimeType;
        arg = [{ base64: images, mimeType: 'image/jpeg' }];
      } else {
        arg = [{ base64: images, mimeType }];
      }
    } else if (typeof mimeType === 'boolean') {
      actualForcePro = mimeType;
    }

    const result = await _parseBase64(arg, apiKey, actualForcePro);

    if (result && result.confidence != null && result.confidence < 0.8) {
      logger.info('Low confidence from Flash model, used Pro fallback', { confidence: result.confidence });
    }

    return result;
  } catch (err) {
    logger.warn('Gemini parsing failed (shared module)', { error: err.message });
    throw err;
  }
}

async function parseReceiptFromText(text, forcePro = false) {
  const apiKey = geminiApiKey.value();
  return _parseText(text, apiKey, forcePro);
}

// Kept for local script usage (test-parse.js etc.). Still works because the shared
// version accepts the apiKey as second argument.
async function parseReceiptFromUrl(imageUrl) {
  const apiKey = geminiApiKey.value();
  return _parseUrl(imageUrl, apiKey);
}

module.exports = {
  PROMPT,                    // re-exported for any internal use that still needs it
  parseReceiptFromUrl,
  parseReceiptFromBase64,
  parseReceiptFromText,
};
