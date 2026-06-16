require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function run() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
    
    // Create a dummy image base64
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const mimeType = "image/png";
    
    const images = [{ base64, mimeType }];
    const PROMPT = "Describe this image in one word.";
    
    const promptParts = images.map(img => ({
      inlineData: { data: img.base64, mimeType: img.mimeType }
    }));
    promptParts.push(PROMPT);
    
    console.log("promptParts:", JSON.stringify(promptParts, null, 2));
    const result = await model.generateContent(promptParts);
    console.log("Result:", result.response.text());
  } catch (e) {
    console.error("ERROR:", e);
  }
}
run();
