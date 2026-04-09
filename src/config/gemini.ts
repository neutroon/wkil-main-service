import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Type,
  Tool,
  Schema
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
  try {
    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: responseMimeType || "text/plain",
      },
    });
    return response.text;
  } catch (error: any) {
    if (error?.status === 403 || error?.message?.includes("403") || error?.message?.includes("PERMISSION_DENIED")) {
      logger.error("Gemini API Permission Denied (403): Your project has been denied access. Please check your Google AI Studio / Google Cloud project status and billing.", {
        error: error.message,
        model: "gemini-2.5-flash",
        tip: "This usually means the project is suspended or the API key is restricted/invalid."
      });
    } else {
      logger.error("Error generating content with Gemini:", { 
        error: error.message,
        status: error?.status 
      });
    }
    throw error;
  }
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

export const aiRoutingSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    action: {
      type: Type.STRING,
      description: "Must be 'REPLY_AUTO', 'HANDOFF_TO_HUMAN', or 'RESOLVE_CONVERSATION'"
    },
    handoffCategory: {
      type: Type.STRING,
      description: "If action is HANDOFF_TO_HUMAN, categorise the reason. E.g., 'SALES_OPPORTUNITY', 'ANGRY_CUSTOMER', 'MISSING_KNOWLEDGE', 'COMPLEX_SUPPORT'",
      nullable: true
    },
    reasoning: {
      type: Type.STRING,
      description: "Internal thought process explaining the action and routing decision."
    },
    content: {
      type: Type.STRING,
      description: "The actual message to send to the user (if replying directly). Required if REPLY_AUTO.",
      nullable: true
    }
  },
  required: ["action", "reasoning"]
};

/**
 * Dynamically builds a Lead Capture tool for Gemini based on custom field mappings.
 * If no custom mapping exists, it defaults to the standard name/email/phone schema.
 */
// Helper function to recursively build Gemini properties globally for any config tool
export const buildDynamicProperties = (mapping: any): Record<string, any> => {
  const props: Record<string, any> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value === "object" && value !== null) {
      
      const mappedType = String((value as any).type).toUpperCase();
      
      if (mappedType === "ARRAY") {
         props[key] = {
           type: Type.ARRAY,
           description: (value as any).description || `List of ${key}`,
           items: {
             type: Type.OBJECT,
             properties: buildDynamicProperties((value as any).items || {})
           }
         };
      } else if (mappedType === "NUMBER" || mappedType === "INTEGER") {
         props[key] = {
           type: mappedType === "INTEGER" ? Type.INTEGER : Type.NUMBER,
           description: (value as any).description || `Numeric value for ${key}`
         };
      } else if (mappedType === "BOOLEAN") {
         props[key] = {
           type: Type.BOOLEAN,
           description: (value as any).description || `True/false flag for ${key}`
         };
      } else {
         const nestedProps = buildDynamicProperties((value as any).properties || value);
         props[key] = {
           type: Type.OBJECT,
           description: (value as any).description || `Details for ${key}`,
           properties: nestedProps, 
           required: Object.keys(nestedProps)
         };
      }
    } else {
      props[key] = {
        type: Type.STRING,
        description: String(value) || `The ${key}`,
      };
    }
  }
  return props;
};

export function buildCaptureLeadTool(fieldMapping: any): Tool[] {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (fieldMapping && typeof fieldMapping === "object" && Object.keys(fieldMapping).length > 0) {
    // Dynamically build properties based on user configuration
    for (const [key, propConfig] of Object.entries(buildDynamicProperties(fieldMapping))) {
      properties[key] = propConfig;
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
      properties = buildDynamicProperties(ds.expectedParamsSchema);
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

  try {
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
  } catch (error: any) {
    if (error?.status === 403 || error?.message?.includes("403") || error?.message?.includes("PERMISSION_DENIED")) {
      logger.error("Gemini Assistant Permission Denied (403): Your project has been denied access. Check project/billing status.", {
        error: error.message,
        tip: "Check AI Studio console for project 'gen-lang-client-0165801924' status."
      });
    }
    throw error;
  }
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
