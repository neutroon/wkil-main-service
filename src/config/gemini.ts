import { GoogleGenAI } from "@google/genai";

// Debug: Log environment variables
console.log("Gemini Config:");
console.log("GEMINI_API_KEY:", process.env.GEMINI_API_KEY ? "Set" : "Not set");

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY environment variable is required");
}

// Initialize Google Generative AI
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Use Gemini 2.5 Flash for content generation (latest available model)
async function generateContent(prompt: string, responseMimeType?: string) {
  const response = await genAI.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: responseMimeType || "text/plain",
    },
  });
  return response.text;
}

// For ingestion — used when embedding chunks
async function embedTexts(texts: string[]): Promise<number[][]> {
  const result = await Promise.all(
    texts.map((t) =>
      genAI.models.embedContent({
        model: "gemini-embedding-001",
        contents: t,
        config: {
          taskType: "RETRIEVAL_DOCUMENT", // ← explicit
          outputDimensionality: 768,
        },
      }),
    ),
  );
  return result.map((r) => r.embeddings![0].values!);
}

// For querying — used when embedding user messages
async function embedQuery(text: string): Promise<number[]> {
  const result = await genAI.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: {
      taskType: "RETRIEVAL_QUERY", // ← different task type
      outputDimensionality: 768,
    },
  });
  return result.embeddings![0].values!;
}

export default generateContent;
export { embedTexts, embedQuery };
