import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Type,
  Tool,
  Schema,
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

/**
 * Types for precise token usage and billing tracking (Gemini Production Standard).
 * These extend the base SDK types to include missing metadata properties.
 */
export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount?: number;
  totalTokenCount: number;
}

/**
 * Extended response interface to access runtime usage data for embeddings.
 * Includes common metadata fields discovered at runtime for Gemini-3 series.
 */
export interface EmbedResponseWithUsage {
  embeddings?: { values: number[] }[];
  usageMetadata?: UsageMetadata;
}

// Model Tier Configuration (April 2026 Production Standards)
// Model Tier Configuration (April 2026 Production Standards)
// const MODELS = {
// PRIMARY: "gemini-3.1-flash", // Current best price/performance
// RESERVE: "gemini-3-flash", // Stable fallback
// STABLE: "gemini-3.1-flash-lite", // Ultra-cheap high-volume
//};

const MODELS = {
  PRIMARY: "gemini-3-flash-preview",        // Best quality
  RESERVE: "gemini-3.1-flash-lite-preview", // Cheaper/faster preview
  STABLE:  "gemini-2.5-flash",              // Non-preview, always available
  IMAGE_GEN: "gemini-3.1-flash-image-preview", // Nano Banana 2 (Visual)
};

/**
 * Robust execution wrapper with exponential backoff and model failover.
 */
export async function executeWithFallback<T>(
  operation: (model: string) => Promise<T>,
  context: string,
  onRetry?: (message: string) => void,
): Promise<{ result: T; model: string }> {
  const tiers = [MODELS.PRIMARY, MODELS.RESERVE, MODELS.STABLE];
  let lastError: any;

  for (let t = 0; t < tiers.length; t++) {
    const currentModel = tiers[t];
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      try {
        const result = await operation(currentModel);
        return { result, model: currentModel };
      } catch (error: any) {
        lastError = error;
        const isRetryable =
          error?.status === 503 ||
          error?.status === 429 ||
          error?.message?.includes("high demand");

        if (isRetryable && attempts < maxAttempts - 1) {
          attempts++;
          // Exponential backoff with jitter (best practice for production resilience)
          const delay = Math.pow(2, attempts) * 1000 + Math.random() * 1000;
          const msg = `[GeminiResilience] ${context} - Model ${currentModel} hit ${error.status || "spike"}. Retrying in ${Math.round(delay)}ms...`;
          logger.warn(msg);
          if (onRetry) onRetry(msg);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }

        // Scale to NEXT tier if available (for both retryable exhaustion and non-retryable errors)
        if (t < tiers.length - 1) {
          const msg = isRetryable
            ? `[GeminiResilience] ${context} - Primary ${currentModel} exhausted. Scaling to Reserve Tier: ${tiers[t + 1]}`
            : `[GeminiResilience] ${context} - Non-retryable error on ${currentModel}. Scaling to next tier: ${tiers[t + 1]}`;
          logger.warn(msg);
          if (onRetry) onRetry(msg);
          break; // Exit attempts loop to move to next model tier
        }

        // Non-retryable error or exhausted all options
        let errorMessage = error.message;
        try {
          // Gemini sometimes wraps error messages as JSON strings; try to extract the clean message
          const parsed = JSON.parse(error.message);
          if (parsed.error?.message) errorMessage = parsed.error.message;
        } catch (e) {}

        logger.error(
          `[GeminiResilience] ${context} Final failure on last tier (${currentModel}):`,
          { error: errorMessage },
        );
        throw new Error(errorMessage);
      }
    }
  }
  throw lastError;
}

export type AiUsageMetadata = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  groundingCalls: number;
  model: string;
};

// Use Gemini 3.1 Flash (Primary) with 3.0 Fallbacks
async function generateContentStream(
  prompt: string,
  responseMimeType?: string,
  enableSearch?: boolean,
  onRetry?: (msg: string) => void,
  temperature: number = 0.4,
) {
  const config: any = {
    temperature,
    responseMimeType: enableSearch
      ? "text/plain"
      : responseMimeType || "text/plain",
    tools: enableSearch ? [{ googleSearch: {} }] : undefined,
  };

  return executeWithFallback(
    async (model) => {
      return await genAI.models.generateContentStream({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config,
      });
    },
    "StrategyStream",
    onRetry,
  );
}

async function generateContent(
  prompt: string,
  responseMimeType?: string,
  enableSearch?: boolean,
  onRetry?: (msg: string) => void,
  temperature: number = 0.4,
): Promise<{ text: string; usage: AiUsageMetadata }> {
  const config: any = {
    temperature,
    responseMimeType: enableSearch
      ? "text/plain"
      : responseMimeType || "text/plain",
    tools: enableSearch ? [{ googleSearch: {} }] : undefined,
  };

  const { result: response, model } = await executeWithFallback(
    async (model) => {
      return await genAI.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config,
      });
    },
    "StrategyPlanning",
    onRetry,
  );

  const usage = response.usageMetadata;
  const grounding = (response as any).candidates?.[0]?.groundingMetadata
    ?.searchEntryPoint;

  return {
    text: response.text || "",
    usage: {
      promptTokens: usage?.promptTokenCount || 0,
      completionTokens: usage?.candidatesTokenCount || 0,
      totalTokens: usage?.totalTokenCount || 0,
      groundingCalls: grounding ? 1 : 0,
      model,
    },
  };
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
      description:
        "Must be 'REPLY_AUTO', 'HANDOFF_TO_HUMAN', or 'RESOLVE_CONVERSATION'",
    },
    intent: {
      type: Type.STRING,
      description:
        "Specifically for Facebook Comments: 'SALES_DM' (wants info), 'GREET_ONLY' (just praise/thanks), or 'IGNORE' (spam). Use 'NONE' for direct chats.",
      nullable: true,
    },
    handoffCategory: {
      type: Type.STRING,
      description:
        "If action is HANDOFF_TO_HUMAN, categorise the reason. E.g., 'SALES_OPPORTUNITY', 'ANGRY_CUSTOMER', 'MISSING_KNOWLEDGE', 'COMPLEX_SUPPORT'",
      nullable: true,
    },
    reasoning: {
      type: Type.STRING,
      description:
        "Internal thought process explaining the action and routing decision.",
    },
    content: {
      type: Type.STRING,
      description:
        "Standard response content. Used as fallback or for direct chats.",
      nullable: true,
    },
    publicContent: {
      type: Type.STRING,
      description:
        "Short, friendly greeting for a public post. Tailored to user's comment.",
      nullable: true,
    },
    privateContent: {
      type: Type.STRING,
      description:
        "Detailed, value-heavy response for a private DM. Prices, details, links.",
      nullable: true,
    },
    attachment: {
      type: Type.OBJECT,
      nullable: true,
      description:
        "Optional media file to send alongside the text reply. ONLY populate this if a matching asset name exists in your Media Catalog. NEVER invent an asset name. NEVER send attachments on public Facebook Comments.",
      properties: {
        assetName: {
          type: Type.STRING,
          description: "Exact name of the asset from the Media Catalog (case-sensitive).",
        },
        caption: {
          type: Type.STRING,
          nullable: true,
          description: "Short caption to accompany the file (e.g. 'Here is our product catalog!').",
        },
      },
    },
  },
  required: ["action", "reasoning", "intent", "publicContent", "privateContent"],
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
            properties: buildDynamicProperties((value as any).items || {}),
          },
        };
      } else if (mappedType === "NUMBER" || mappedType === "INTEGER") {
        props[key] = {
          type: mappedType === "INTEGER" ? Type.INTEGER : Type.NUMBER,
          description: (value as any).description || `Numeric value for ${key}`,
        };
      } else if (mappedType === "BOOLEAN") {
        props[key] = {
          type: Type.BOOLEAN,
          description:
            (value as any).description || `True/false flag for ${key}`,
        };
      } else {
        const nestedProps = buildDynamicProperties(
          (value as any).properties || value,
        );
        props[key] = {
          type: Type.OBJECT,
          description: (value as any).description || `Details for ${key}`,
          properties: nestedProps,
          required: Object.keys(nestedProps),
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

export const DEFAULT_LEAD_CAPTURE_INSTRUCTIONS = "Captures a prospective lead's information. Trigger this ONLY when the user explicitly expresses strong buying intent, asks for a callback, tells you their contact details, or wants to proceed with an action.";

export function buildCaptureLeadTool(fieldMapping: any, customInstructions?: string): Tool[] {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (
    fieldMapping &&
    typeof fieldMapping === "object" &&
    Object.keys(fieldMapping).length > 0
  ) {
    // Dynamically build properties based on user configuration
    for (const [key, propConfig] of Object.entries(
      buildDynamicProperties(fieldMapping),
    )) {
      properties[key] = propConfig;
      required.push(key);
    }
  } else {
    // Default Schema Standard
    properties["name"] = {
      type: Type.STRING,
      description: "The full name of the prospect.",
    };
    properties["email"] = {
      type: Type.STRING,
      description: "The email address of the prospect.",
    };
    properties["phone"] = {
      type: Type.STRING,
      description: "The phone number of the prospect.",
    };
    properties["notes"] = {
      type: Type.STRING,
      description: "A summary of the prospect's intent.",
    };
    required.push("name");
  }

  return [
    {
      functionDeclarations: [
        {
          name: "capture_lead",
          description: customInstructions || DEFAULT_LEAD_CAPTURE_INSTRUCTIONS,
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

    if (
      ds.expectedParamsSchema &&
      typeof ds.expectedParamsSchema === "object"
    ) {
      properties = buildDynamicProperties(ds.expectedParamsSchema);
      required = Object.keys(properties);
    }

    return {
      name: `query_external_api_${ds.id}`,
      description:
        ds.description ||
        `Fetch data from ${ds.name}. Ask user for required fields if missing.`,
      parameters: {
        type: Type.OBJECT,
        properties:
          Object.keys(properties).length > 0
            ? properties
            : { q: { type: Type.STRING, description: "Optional search term" } },
      },
    };
  });

  return [{ functionDeclarations }];
}

/**
 * Structured generation for Messenger: system instruction + explicit turns.
 * ⚠️ If tools are passed, check response.candidates[0].content.parts
 * for functionCall parts and handle the tool execution loop externally.
 * This function does NOT auto-execute tool calls.
 */
export async function generateMessengerAssistantReply(params: {
  systemInstruction: string;
  /** Prior turns only (excludes the latest customer message). */
  historyTurns: { role: "user" | "model"; text?: string; parts?: any[] }[];
  customerMessage: string;
  tools?: Tool[];
  temperature?: number;
}): Promise<{ response: any; usage: AiUsageMetadata }> {
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
    const { result: response, model } = await executeWithFallback(
      async (model) => {
        return await genAI.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: params.systemInstruction,
            temperature: params.temperature ?? 0.4,
            maxOutputTokens: 1024,
            responseMimeType: "text/plain",
            safetySettings: MESSENGER_SAFETY_SETTINGS,
            tools: params.tools,
          },
        });
      },
      "MessengerAssistant",
    );

    const usage = response.usageMetadata;
    const grounding = (response as any).candidates?.[0]?.groundingMetadata
      ?.searchEntryPoint;

    return {
      response,
      usage: {
        promptTokens: usage?.promptTokenCount || 0,
        completionTokens: usage?.candidatesTokenCount || 0,
        totalTokens: usage?.totalTokenCount || 0,
        groundingCalls: grounding ? 1 : 0,
        model,
      },
    };
  } catch (error: any) {
    if (
      error?.status === 403 ||
      error?.message?.includes("403") ||
      error?.message?.includes("PERMISSION_DENIED")
    ) {
      logger.error(
        "Gemini Assistant Permission Denied (403): Your project has been denied access. Check project/billing status.",
        {
          error: error.message,
          tip: "Check AI Studio console for project 'gen-lang-client-0165801924' status.",
        },
      );
    }
    throw error;
  }
}

// For ingestion — used when embedding chunks
async function embedTexts(
  texts: string[],
): Promise<{ embeddings: number[][]; totalTokens: number }> {
  let totalTokens = 0;
  const result = await Promise.all(
    texts.map(async (t) => {
      const res = (await genAI.models.embedContent({
        model: "gemini-embedding-001",
        contents: t,
        config: {
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: 768,
        },
      })) as EmbedResponseWithUsage;

      const tokens = res.usageMetadata?.totalTokenCount ?? 0;
      if (!tokens) {
        logger.warn(
          `[GeminiBilling] No usageMetadata returned for embedding model. Fallover to 0. Check API version.`,
        );
      } else {
        logger.debug(`[GeminiBilling] Embedding tokens captured: ${tokens}`);
      }

      totalTokens += tokens;
      return res;
    }),
  );
  return {
    embeddings: result.map((r) => r.embeddings![0].values!),
    totalTokens,
  };
}

// For querying — used when embedding user messages
async function embedQuery(
  text: string,
): Promise<{ vector: number[]; totalTokens: number }> {
  if (!text || text.trim().length === 0) {
    return { vector: new Array(768).fill(0), totalTokens: 0 };
  }
  const result = (await genAI.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: {
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: 768,
    },
  })) as EmbedResponseWithUsage;

  const tokens = result.usageMetadata?.totalTokenCount ?? 0;

  return {
    vector: result.embeddings![0].values!,
    totalTokens: tokens,
  };
}

export async function generateVisualContent(params: {
  prompt: string;
  imageBuffer?: Buffer; // For editing existing images
  brandLogoBuffer?: Buffer; // For native branding
  mimeType?: string;
  brandLogoMimeType?: string;
  onRetry?: (msg: string) => void;
  aspectRatio?: string; // e.g. "1:1", "16:9", "9:16"
}): Promise<{ imageBuffer: Buffer; usage: AiUsageMetadata }> {
  // Use specialized image generation tier
  const model = MODELS.IMAGE_GEN;

  // Prepare contents array
  const parts: any[] = [{ text: params.prompt }];
  
  // If editing, add the base image
  if (params.imageBuffer) {
    parts.push({
      inlineData: {
        data: params.imageBuffer.toString("base64"),
        mimeType: params.mimeType || "image/png",
      },
    });
  }

  // If branding, add the brand logo as a reference image
  if (params.brandLogoBuffer) {
    parts.push({
      inlineData: {
        data: params.brandLogoBuffer.toString("base64"),
        mimeType: params.brandLogoMimeType || "image/png",
      },
    });
  }

  try {
    const response = await genAI.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        // High fidelity social parameters for April 2026
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    });

    // DEBUG: Log raw response to verify usage reporting structure for image models
    logger.debug("gemini_visual.raw_response_metadata", { 
      hasUsage: Boolean(response.usageMetadata),
      usage: response.usageMetadata,
      candidateCount: response.candidates?.length
    });

    const usage = response.usageMetadata;

    // Extract image binary from the multimodal response parts
    const imagePart = response.candidates?.[0]?.content?.parts?.find(
      (p: any) => p.inlineData || p.fileData
    );

    if (!imagePart || (!imagePart.inlineData && !imagePart.fileData)) {
      throw new Error("No image was generated in the response parts. Safety filter might have triggered.");
    }

    const base64Data = imagePart.inlineData?.data || (imagePart as any).fileData?.data;
    if (!base64Data) throw new Error("Image data was empty in the response (Model might have returned a File URI instead of bytes).");

    logger.info("gemini_visual.token_usage", { 
      promptTokens: usage?.promptTokenCount || 0, 
      completionTokens: usage?.candidatesTokenCount || 0,
      model
    });

    return {
      imageBuffer: Buffer.from(base64Data, "base64"),
      usage: {
        promptTokens: usage?.promptTokenCount || 0,
        completionTokens: usage?.candidatesTokenCount || 0, // Pixels are counted as output tokens
        totalTokens: usage?.totalTokenCount || 0,
        groundingCalls: 0,
        model,
      },
    };
  } catch (error: any) {
    logger.error(`[GeminiVisual] Final failure on model ${model}:`, { error: error.message });
    throw error;
  }
}

export { generateContent, generateContentStream, embedTexts, embedQuery };
