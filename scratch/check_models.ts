import { GoogleGenAI } from "@google/genai";
import * as dotenv from "dotenv";

/**
 * AI Infrastructure Diagnostic Tool
 * Verifies model availability and SDK handshake for Google Gemini.
 */

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("CRITICAL ERROR: GEMINI_API_KEY is not defined in the environment.");
  process.exit(1);
}

const client = new GoogleGenAI({ apiKey: API_KEY });

async function verifyModelAvailability() {
  console.log("--- Starting AI Infrastructure Diagnostic ---");
  
  // Production-ready models to verify
  const modelsToTest = [
    "gemini-2.0-flash", 
    "gemini-2.0-flash-lite-preview-02-05", 
    "gemini-1.5-flash", 
    "gemini-1.5-pro"
  ];

  const results: { model: string; status: "PASS" | "FAIL"; details: string }[] = [];

  for (const modelId of modelsToTest) {
    try {
      // Direct health check: Generate a minimal token response
      await client.models.generateContent({
        model: modelId,
        contents: [{ role: "user", parts: [{ text: "ping" }] }]
      });

      results.push({ 
        model: modelId, 
        status: "PASS", 
        details: "Handshake successful" 
      });
    } catch (error: any) {
      results.push({ 
        model: modelId, 
        status: "FAIL", 
        details: error.message 
      });
    }
  }

  // Generate structured report
  console.table(results);
  console.log("--- Diagnostic Complete ---");
}

verifyModelAvailability().catch((err) => {
  console.error("UNEXPECTED SYSTEM FAILURE:", err.message);
  process.exit(1);
});
