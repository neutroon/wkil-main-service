import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/genai";
import { logger } from "../utils/logger";

if (process.env.NODE_ENV !== "production") {
  logger.debug("gemini.config", {
    geminiApiKeySet: Boolean(process.env.GEMINI_API_KEY),
  });
}

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

const MESSENGER_SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
];

/**
 * Structured generation for Messenger: system instruction + explicit turns (better than one concatenated blob).
 */
export async function generateMessengerAssistantReply(params: {
  systemInstruction: string;
  /** Prior turns only (excludes the latest customer message). */
  historyTurns: { role: "user" | "model"; text: string }[];
  customerMessage: string;
}): Promise<string | undefined> {
  const contents = [
    ...params.historyTurns.map((t) => ({
      role: t.role,
      parts: [{ text: t.text }],
    })),
    {
      role: "user" as const,
      parts: [{ text: params.customerMessage }],
    },
  ];

  const response = await genAI.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction: params.systemInstruction,
      temperature: 0.35,
      maxOutputTokens: 512,
      responseMimeType: "text/plain",
      safetySettings: MESSENGER_SAFETY_SETTINGS,
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
