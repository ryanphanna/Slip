const admin = require('firebase-admin');
const config = require('./config');

async function saveImages(images, messageSid, receipt = null) {
  const bucket = admin.storage().bucket();
  const paths = [];
  
  // Sanitize messageSid to prevent path traversal (alphanumeric only)
  const safeSid = (messageSid || 'unknown').replace(/[^a-zA-Z0-9]/g, '');

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

    if (isHighValue || isTaxOrMedical || isLowConfidence || isRndMerchant) {
      prefix = config.STORAGE_PREFIX_PERMANENT;
    }
  }

  for (let i = 0; i < images.length; i++) {
    const { base64, mimeType } = images[i];
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const path = `${prefix}/${safeSid}/${i}.${ext}`;
    const file = bucket.file(path);

    await file.save(Buffer.from(base64, 'base64'), {
      metadata: { contentType: mimeType },
    });

    paths.push(path);
  }

  return paths;
}

module.exports = { saveImages };
