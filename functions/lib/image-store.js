const admin = require('firebase-admin');

async function saveImages(images, messageSid) {
  const bucket = admin.storage().bucket();
  const paths = [];
  
  // Sanitize messageSid to prevent path traversal (alphanumeric only)
  const safeSid = (messageSid || 'unknown').replace(/[^a-zA-Z0-9]/g, '');

  for (let i = 0; i < images.length; i++) {
    const { base64, mimeType } = images[i];
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const path = `receipts/${safeSid}/${i}.${ext}`;
    const file = bucket.file(path);

    await file.save(Buffer.from(base64, 'base64'), {
      metadata: { contentType: mimeType },
    });

    paths.push(path);
  }

  return paths;
}

module.exports = { saveImages };
