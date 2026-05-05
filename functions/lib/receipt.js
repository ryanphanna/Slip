const { GoogleGenerativeAI } = require('@google/generative-ai');
const { defineSecret } = require('firebase-functions/params');

const geminiApiKey = defineSecret('GEMINI_API_KEY');

const PROMPT = `Extract the receipt data and return ONLY valid JSON — no markdown, no explanation:
{
  "merchant": "store name",
  "location": "store address or location as printed on receipt, or null",
  "date": "YYYY-MM-DD or null",
  "total": number or null,
  "subtotal": number or null,
  "tax": number or null,
  "category": "one of: Takeout/Dining, Grocery, Transport, Shopping, Entertainment, Health, Home, Other",
  "subCategory": "Provide a specific sub-category based on the merchant (e.g. Coffee Shop, Fast Food, Supermarket, Electronics, Pharmacy, Rideshare, Clothing, Alcohol)",
  "items": [{ "name": "item name", "price": number }],
  "currency": "Currency code (e.g. CAD, USD, EUR). Infer from location if implied.",
  "type": "purchase or refund",
  "loyaltyPointsEarned": number or null,
  "loyaltyPointsBalance": number or null
}
Use null for anything you can't determine. Items can be an empty array.
For each item, record the final net price paid after any inline per-item discount shown beneath it on the receipt. Do not add a separate line item for any discount summary or coupon total that appears at the bottom — if per-item discounts are already reflected in individual prices, the summary line is redundant and should be omitted.`;

async function parseReceiptFromBase64(images) {
  // Backwards compatibility for single string signature
  if (typeof images === 'string') {
    images = [{ base64: arguments[0], mimeType: arguments[1] || 'image/jpeg' }];
  }

  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
  
  const promptParts = images.map(img => ({
    inlineData: { data: img.base64, mimeType: img.mimeType }
  }));
  promptParts.push({ text: PROMPT });

  // Try parsing with Gemini 3 Flash first
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    
    const result = await model.generateContent(promptParts);
    let raw = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Primary model (gemini-3-flash) failed, attempting fallback to gemini-3.1-pro:', err.message);
    
    // Fallback to Gemini 3.1 Pro
    const fallbackModel = genAI.getGenerativeModel({ 
      model: 'gemini-3.1-pro',
      generationConfig: { responseMimeType: 'application/json' }
    });
    
    const result = await fallbackModel.generateContent(promptParts);
    let raw = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(raw);
  }
}

// Used by scripts/test-parse.js
async function parseReceiptFromUrl(imageUrl) {
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) throw new Error(`Failed to fetch image: ${imgResponse.status}`);
  const buffer = await imgResponse.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mimeType = imgResponse.headers.get('content-type') || 'image/jpeg';
  return parseReceiptFromBase64(base64, mimeType);
}

async function parseReceiptFromText(text) {
  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash',
    generationConfig: {
      responseMimeType: 'application/json'
    }
  });

  const result = await model.generateContent([
    { text: PROMPT },
    { text: `Receipt Text:\n${text}` }
  ]);

  const responseText = result.response.text();
  let cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  
  return JSON.parse(cleanJson);
}

module.exports = { parseReceiptFromUrl, parseReceiptFromBase64, parseReceiptFromText };
