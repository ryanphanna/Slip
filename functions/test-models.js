
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // We can't list models directly with standard SDK easily without raw fetch.
  // Let's just try to generate content with gemini-3-flash and gemini-2.0-flash.
  
  try {
    const m3 = genAI.getGenerativeModel({ model: 'gemini-3-flash' });
    await m3.generateContent("Hello");
    console.log("gemini-3-flash works");
  } catch (e) {
    console.error("gemini-3-flash error:", e.message);
  }
  
  try {
    const m20 = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    await m20.generateContent("Hello");
    console.log("gemini-2.0-flash works");
  } catch (e) {
    console.error("gemini-2.0-flash error:", e.message);
  }

  try {
    const m15 = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    await m15.generateContent("Hello");
    console.log("gemini-1.5-flash works");
  } catch (e) {
    console.error("gemini-1.5-flash error:", e.message);
  }
}

listModels();
