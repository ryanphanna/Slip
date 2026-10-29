const admin = require('firebase-admin');
const config = require('./config');
const { checkFlags } = require('./receipt-checks');

async function saveImageFiles(images, messageSid, prefix) {
  const bucket = admin.storage().bucket();

  // Sanitize messageSid to prevent path traversal (alphanumeric only)
  const safeSid = (messageSid || 'unknown').replace(/[^a-zA-Z0-9]/g, '');

  const uploadPromises = images.map(async (img, idx) => {
    const ext = img.mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    // Photos from a text with several receipts keep their number in the text.
    const number = Number.isInteger(img.index) ? img.index : idx;
    const path = `${prefix}/${safeSid}/${number}.${ext}`;
    const file = bucket.file(path);

    await file.save(Buffer.from(img.base64, 'base64'), {
      metadata: { contentType: img.mimeType },
    });

    return path;
  });

  return Promise.all(uploadPromises);
}

async function saveImages(images, messageSid, receipt = null) {
  // Determine prefix: permanent vs temporary
  let prefix = config.STORAGE_PREFIX_TEMPORARY;
  
  if (receipt) {
    const total = receipt.total != null ? Math.abs(receipt.total) : 0;
    const category = (receipt.category || '').trim();
    const confidence = receipt.confidence != null ? Number(receipt.confidence) : 1.0;
    const merchant = (receipt.merchant || '').toLowerCase();

    const isHighValue = total >= config.PERMANENT_TOTAL_THRESHOLD;
    const isTaxOrMedical = config.PERMANENT_CATEGORIES.includes(category);
    const isLowConfidence = confidence < config.PERMANENT_CONFIDENCE_THRESHOLD;
    const isRndMerchant = config.PERMANENT_MERCHANTS.some(m => merchant.includes(m.toLowerCase()));

    // Receipts flagged for checking keep their photo, so the check can still
    // be done after temporary photos are deleted.
    const needsCheck = Object.keys(checkFlags(receipt, { fromPhotos: true })).length > 0;

    if (isHighValue || isTaxOrMedical || isLowConfidence || isRndMerchant || needsCheck) {
      prefix = config.STORAGE_PREFIX_PERMANENT;
    }
  }

  return saveImageFiles(images, messageSid, prefix);
}

async function saveFailedImages(images, messageSid) {
  return saveImageFiles(images, messageSid, config.STORAGE_PREFIX_FAILED);
}

module.exports = { saveImages, saveFailedImages };
