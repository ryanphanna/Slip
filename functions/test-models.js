
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // We can't list models directly with standard SDK easily without raw fetch.
  // Let's just try the live aliases and one older fallback.
  
  try {
    const mLatest = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
    await mLatest.generateContent("Hello");
    console.log("gemini-flash-latest works");
  } catch (e) {
    console.error("gemini-flash-latest error:", e.message);
  }
  
  try {
    const m20 = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    await m20.generateContent("Hello");
    console.log("gemini-2.0-flash works");
  } catch (e) {
    console.error("gemini-2.0-flash error:", e.message);
  }

  try {
    const mPro = genAI.getGenerativeModel({ model: 'gemini-pro-latest' });
    await mPro.generateContent("Hello");
    console.log("gemini-pro-latest works");
  } catch (e) {
    console.error("gemini-pro-latest error:", e.message);
  }
}

listModels();
