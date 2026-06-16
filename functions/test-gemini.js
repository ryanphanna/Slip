require('dotenv').config({ path: '.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testArray() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
  
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const mimeType = "image/png";
  const images = [{ base64, mimeType }];
  
  const PROMPT = "Describe this image in one word.";
  
  const promptParts = images.map(img => ({
    inlineData: { data: img.base64, mimeType: img.mimeType }
  }));
  promptParts.push({ text: PROMPT }); // Wait, testing with object
  
  const result = await model.generateContent(promptParts);
  console.log("With object:", result.response.text());
  
  const promptParts2 = images.map(img => ({
    inlineData: { data: img.base64, mimeType: img.mimeType }
  }));
  promptParts2.push(PROMPT); // Testing with string
  
  const result2 = await model.generateContent(promptParts2);
  console.log("With string:", result2.response.text());
}
testArray().catch(console.error);
