import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";

async function listModels() {
  try {
    const res = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models?key=\${GOOGLE_AI_API_KEY}\`);
    const data = await res.json();
    console.log(JSON.stringify(data.models.map((m: any) => m.name), null, 2));
  } catch (err) {
    console.error(err);
  }
}

listModels();