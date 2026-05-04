const { defineSecret } = require('firebase-functions/params');
const twilio = require('twilio');
const { fetchMedia } = require('../lib/twilio');
const { parseReceiptFromBase64 } = require('../lib/receipt');
const { validateReceipt } = require('../lib/validate');
const { saveReceipt } = require('../lib/store');
const admin = require('firebase-admin');

// Ensure we have access to the credentials
admin.initializeApp({ projectId: 'slip-c742b' });

async function replayRecent() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    console.error('Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN env vars.');
    process.exit(1);
  }

  const client = twilio(accountSid, authToken);

  console.log('Fetching recent incoming messages...');
  const messages = await client.messages.list({
    limit: 10
  });

  const incoming = messages.filter(m => m.direction === 'inbound' && m.numMedia > 0);
  
  console.log(`Found ${incoming.length} recent inbound messages with media.`);

  for (const msg of incoming) {
    console.log(`\nReplaying MessageSid: ${msg.sid} from ${msg.from}`);
    
    // Check if it already exists
    const existing = await admin.firestore().collection('receipts').where('messageSid', '==', msg.sid).limit(1).get();
    if (!existing.empty) {
       console.log(` -> Already processed in Firestore. Skipping.`);
       continue;
    }

    // Fetch media details for this message
    const mediaList = await client.messages(msg.sid).media.list({ limit: 1 });
    if (mediaList.length === 0) {
       console.log(' -> No media found.');
       continue;
    }

    const mediaUrl = `https://api.twilio.com${mediaList[0].uri.replace('.json', '')}`;
    console.log(` -> Fetching media: ${mediaUrl}`);

    try {
      // Need to fetch media using Twilio basic auth
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const imgResponse = await fetch(mediaUrl, {
        headers: { Authorization: `Basic ${auth}` }
      });
      
      if (!imgResponse.ok) {
        console.error(` -> Failed to fetch media: ${imgResponse.status} ${imgResponse.statusText}`);
        continue;
      }
      
      const mimeType = imgResponse.headers.get('content-type') || 'image/jpeg';
      const buffer = await imgResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      
      console.log(` -> Parsing with Gemini (MIME: ${mimeType})...`);
      const raw = await parseReceiptFromBase64(base64, mimeType);
      const receipt = validateReceipt(raw);
      
      console.log(` -> Extracted: ${receipt.merchant} - Total: ${receipt.total} - Loyalty Points: ${receipt.loyaltyPointsEarned || 'None'}`);
      
      await saveReceipt(receipt, msg.from, msg.sid);
      console.log(' -> Saved to Firestore successfully!');
      
      // Send success SMS
      const merchant = receipt.merchant || 'Unknown';
      const total = receipt.total != null ? `$${Math.abs(receipt.total).toFixed(2)}` : '?';
      const prefix = receipt.type === 'refund' ? 'Saved Refund' : 'Saved';
      
      await client.messages.create({
        body: `${prefix}: ${merchant} — ${total} (${receipt.category}) [Replayed]`,
        from: msg.to,
        to: msg.from
      });
      console.log(' -> Confirmation SMS sent.');
    } catch (err) {
      console.error(' -> Error processing message:', err.message || err);
      // Fallback SMS
      await client.messages.create({
        body: `Couldn't read that receipt. Try a clearer photo. [Replayed]`,
        from: msg.to,
        to: msg.from
      }).catch(() => {});
    }
  }
}

replayRecent().catch(console.error);
