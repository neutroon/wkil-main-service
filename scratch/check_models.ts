import { GoogleGenAI } from "@google/genai";
import * as dotenv from "dotenv";
dotenv.config();

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

async function listModels() {
  try {
    // Note: The @google/genai SDK might not have a direct listModels yet in all versions
    // but we can try to fetch them or check the documentation.
    // Actually, let's use a simple fetch if needed, 
    // or check the typical names.
    console.log("Checking model availability...");
    
    // Attempting a very basic call to check if a model exists
    const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-3-flash"];
    
    for (const m of models) {
        try {
            // In v1.46.0, we use genAI.models directly
            const response = await (genAI as any).models.generateContent({
                model: m,
                contents: [{ role: "user", parts: [{ text: "hi" }] }]
            });
            console.log(`Model check: ${m} - OK (Response received)`);
        } catch (e: any) {
            console.log(`Model check: ${m} - FAILED: ${e.message}`);
        }
    }
  } catch (error) {
    console.error("Error listing models:", error);
  }
}

listModels();
