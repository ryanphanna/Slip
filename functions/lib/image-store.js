const admin = require('firebase-admin');

async function saveImages(images, messageSid, receipt = null) {
  const bucket = admin.storage().bucket();
  const paths = [];
  
  // Sanitize messageSid to prevent path traversal (alphanumeric only)
  const safeSid = (messageSid || 'unknown').replace(/[^a-zA-Z0-9]/g, '');

  // Determine prefix: permanent vs temporary
  let prefix = 'receipts-temporary';
  
  if (receipt) {
    const total = receipt.total != null ? Math.abs(receipt.total) : 0;
    const category = (receipt.category || '').trim();
    const confidence = receipt.confidence != null ? Number(receipt.confidence) : 1.0;
    const merchant = (receipt.merchant || '').toLowerCase();

    const isHighValue = total >= 100;
    const isTaxOrMedical = ['Health', 'Home'].includes(category);
    const isLowConfidence = confidence < 0.8;
    const isRndMerchant = merchant.includes('ikea');

    if (isHighValue || isTaxOrMedical || isLowConfidence || isRndMerchant) {
      prefix = 'receipts-permanent';
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
