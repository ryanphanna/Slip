const Anthropic = require('@anthropic-ai/sdk');
const { defineSecret } = require('firebase-functions/params');

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');

async function parseReceiptFromUrl(mediaUrl) {
  // Twilio media URLs require HTTP Basic auth
  const auth = Buffer.from(
    `${twilioAccountSid.value()}:${twilioAuthToken.value()}`
  ).toString('base64');

  const imgResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!imgResponse.ok) {
    throw new Error(`Failed to fetch media: ${imgResponse.status}`);
  }

  const buffer = await imgResponse.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mediaType = imgResponse.headers.get('content-type') || 'image/jpeg';

  const client = new Anthropic({ apiKey: anthropicApiKey.value() });

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `Extract the receipt data and return ONLY valid JSON — no markdown, no explanation:
{
  "merchant": "store name",
  "date": "YYYY-MM-DD or null",
  "total": number or null,
  "subtotal": number or null,
  "tax": number or null,
  "category": "one of: Food, Grocery, Transport, Shopping, Entertainment, Health, Other",
  "items": [{ "name": "item name", "price": number }],
  "currency": "CAD"
}
Use null for anything you can't determine. Items can be an empty array.`,
        },
      ],
    }],
  });

  const raw = message.content[0].text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(raw);
}

module.exports = { parseReceiptFromUrl };
