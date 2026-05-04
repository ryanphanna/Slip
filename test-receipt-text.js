require('dotenv').config({path: './functions/.env'}); // Note: we're not inside functions/
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Let's just run parseReceiptFromText
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "dummy");
const PROMPT = "extract data";
async function run() {
  try {
    const { parseReceiptFromText } = require('./functions/lib/receipt');
    // Note: firebase-functions/params defineSecret won't work locally without emulator!
  } catch (e) {
    console.error(e);
  }
}
run();
