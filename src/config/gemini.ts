import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Type,
  Tool
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
export const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

export const MESSENGER_SAFETY_SETTINGS = [
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
 * Dynamically builds a Lead Capture tool for Gemini based on custom field mappings.
 * If no custom mapping exists, it defaults to the standard name/email/phone schema.
 */
export function buildCaptureLeadTool(fieldMapping: any): Tool[] {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (fieldMapping && typeof fieldMapping === "object" && Object.keys(fieldMapping).length > 0) {
    // Dynamically build properties based on user configuration
    for (const [key, description] of Object.entries(fieldMapping)) {
      properties[key] = {
        type: Type.STRING,
        description: String(description) || `The ${key} provided by the prospect.`,
      };
      required.push(key);
    }
  } else {
    // Default Schema Standard
    properties["name"] = { type: Type.STRING, description: "The full name of the prospect." };
    properties["email"] = { type: Type.STRING, description: "The email address of the prospect." };
    properties["phone"] = { type: Type.STRING, description: "The phone number of the prospect." };
    properties["notes"] = { type: Type.STRING, description: "A summary of the prospect's intent." };
    required.push("name");
  }

  return [
    {
      functionDeclarations: [
        {
          name: "capture_lead",
          description:
            "Captures a prospective lead's information. Trigger this ONLY when the user explicitly expresses strong buying intent, asks for a callback, tells you their contact details, or wants to proceed with an action.",
          parameters: {
            type: Type.OBJECT,
            properties,
            required,
          },
        },
      ],
    },
  ];
}

export function buildExternalQueryTools(dataSources: any[]): Tool[] {
  if (!dataSources || dataSources.length === 0) return [];
  
  const functionDeclarations = dataSources.map((ds) => {
    let properties: any = {};
    let required: string[] = [];

    if (ds.expectedParamsSchema && typeof ds.expectedParamsSchema === "object") {
      for (const [key, val] of Object.entries(ds.expectedParamsSchema)) {
        properties[key] = { type: Type.STRING, description: String(val) };
      }
      required = Object.keys(properties);
    }

    return {
      name: `query_external_api_${ds.id}`,
      description: ds.description || `Fetch data from ${ds.name}. Ask user for required fields if missing.`,
      parameters: {
        type: Type.OBJECT,
        properties: Object.keys(properties).length > 0 ? properties : { q: { type: Type.STRING, description: "Optional search term" } },
      },
    };
  });

  return [{ functionDeclarations }];
}

/**
 * Structured generation for Messenger: system instruction + explicit turns (better than one concatenated blob).
 */
export async function generateMessengerAssistantReply(params: {
  systemInstruction: string;
  /** Prior turns only (excludes the latest customer message). */
  historyTurns: { role: "user" | "model"; text?: string; parts?: any[] }[];
  customerMessage: string;
  tools?: Tool[];
}): Promise<any> {
  const contents = [
    ...params.historyTurns.map((t) => ({
      role: t.role,
      parts: t.parts ? t.parts : [{ text: t.text }],
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
      tools: params.tools,
    },
  });

  return response;
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
