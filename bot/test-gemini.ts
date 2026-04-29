import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const genAI = new GoogleGenerativeAI(GOOGLE_AI_API_KEY);

async function test() {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `You are an intent parser. Extract the SKU (product name), max price, and quantity from the following user message. Return ONLY a valid JSON object with the keys "sku", "maxPrice", and "qty", and absolutely no markdown formatting, text, or backticks around it. If values are missing or invalid, do your best to infer or return a clear error in JSON.\nMessage: "I want 5 T-shirts for under 10 usdc"`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    console.log("Raw Gemini Output:");
    console.log(responseText);
    
    const cleaned = responseText.trim().replace(/```json/g, "").replace(/```/g, "");
    console.log("Cleaned Output:", cleaned);
    
    const parsed = JSON.parse(cleaned);
    console.log("Parsed JSON:", parsed);

  } catch (err) {
    console.error("Gemini Error:", err);
  }
}

test();