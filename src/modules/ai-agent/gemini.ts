import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Type,
  Tool,
  Schema,
} from "@google/genai";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

import { wrapGemini } from "langsmith/wrappers/gemini";
import { env } from "@config/env";

const { GEMINI_API_KEY } = env;

// Initialize Google Generative AI and wrap it with LangSmith for tracing
const rawGenAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
export const genAI =
  process.env.LANGCHAIN_TRACING_V2 === "true" ? wrapGemini(rawGenAI) : rawGenAI;

/**
 * Types for precise token usage and billing tracking (Gemini Production Standard).
 * These extend the base SDK types to include missing metadata properties.
 */
export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount?: number;
  totalTokenCount: number;
}

export interface EmbedResponseWithUsage {
  embeddings?: { values: number[] }[];
  usageMetadata?: UsageMetadata;
}

/**
 * Strict typing for Multimodal parts (April 2026 SDK Extensions)
 */
export interface GeminiPart {
  text?: string;
  inlineData?: {
    data: string;
    mimeType: string;
  };
  fileData?: {
    fileUri: string;
    mimeType: string;
  };
}

// Model Tier Configuration (April 2026 Production Standards)
// Model Tier Configuration (April 2026 Production Standards)
// const MODELS = {
// PRIMARY: "gemini-3.1-flash", // Current best price/performance
// RESERVE: "gemini-3-flash", // Stable fallback
// STABLE: "gemini-3.1-flash-lite", // Ultra-cheap high-volume
//};

const MODELS = {
  PRIMARY: "gemini-3-flash-preview", // Best quality
  RESERVE: "gemini-3.1-flash-lite-preview", // Cheaper/faster preview
  STABLE: "gemini-2.5-flash", // Non-preview, always available
  IMAGE_GEN: "gemini-3.1-flash-image-preview", // Nano Banana 2 (Visual)
};

/**
 * Robust execution wrapper with exponential backoff and model failover.
 */
export async function executeWithFallback<T>(
  operation: (model: string) => Promise<T>,
  context: string,
  onRetry?: (message: string) => void,
  customTiers?: string[],
): Promise<{ result: T; model: string }> {
  const tiers = customTiers || [MODELS.PRIMARY, MODELS.RESERVE, MODELS.STABLE];
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

        logger.error(`Gemini final failure: ${errorMessage}`);
        throw new AppError(errorMessage, 502);
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
/**
 * Shared configuration builder for Gemini requests.
 */
function buildRequestConfig(params: {
  temperature: number;
  responseMimeType?: string;
  enableSearch?: boolean;
}) {
  return {
    temperature: params.temperature,
    // Google Search grounding requires text/plain, so it intentionally overrides
    // the caller's requested response MIME type when enabled.
    responseMimeType: params.enableSearch
      ? "text/plain"
      : params.responseMimeType || "text/plain",
    tools: params.enableSearch ? [{ googleSearch: {} }] : undefined,
  };
}

async function generateContentStream(
  prompt: string,
  responseMimeType?: string,
  enableSearch?: boolean,
  onRetry?: (msg: string) => void,
  temperature: number = 0.4,
) {
  const config = buildRequestConfig({
    temperature,
    responseMimeType,
    enableSearch,
  });

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
  const config = buildRequestConfig({
    temperature,
    responseMimeType,
    enableSearch,
  });

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
  const grounding =
    response.candidates?.[0]?.groundingMetadata?.searchEntryPoint;

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

const attachmentSchema: Schema = {
  type: Type.OBJECT,
  nullable: true,
  description:
    "Optional media file to send alongside the text reply. ONLY populate this if a matching asset name exists in your Media Catalog. NEVER invent an asset name. NEVER send attachments on public Facebook Comments.",
  properties: {
    assetName: {
      type: Type.STRING,
      description:
        "Exact name of the asset from the Media Catalog (case-sensitive).",
    },
    caption: {
      type: Type.STRING,
      nullable: true,
      description:
        "Short caption to accompany the file (e.g. 'Here is our product catalog!').",
    },
  },
};

const baseRoutingProperties: Record<string, Schema> = {
  action: {
    type: Type.STRING,
    description:
      "Must be 'REPLY_AUTO', 'HANDOFF_TO_HUMAN', or 'RESOLVE_CONVERSATION'",
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
  requiresGrounding: {
    type: Type.BOOLEAN,
    description:
      "True when the customer-facing response makes factual business claims that require retrieved business evidence. False for greetings, thanks, spam ignores, clarification questions, or pure handoff copy.",
  },
  grounded: {
    type: Type.BOOLEAN,
    description:
      "True only when the customer-facing factual answer is supported by provided business context, post context, chat history, or verified tool results.",
  },
  usedChunkTypes: {
    type: Type.ARRAY,
    description:
      "Business context chunk types used as evidence, e.g. identity, contact, faq, product, custom_section, raw_content. Empty array if none.",
    items: {
      type: Type.STRING,
    },
  },
  missingInfo: {
    type: Type.STRING,
    nullable: true,
    description:
      "Specific missing fact needed to answer safely. Null when no evidence is missing.",
  },
  attachment: attachmentSchema,
};

export function buildAiRoutingSchema(channel?: string | null): Schema {
  if (channel === "facebook_comment") {
    return {
      type: Type.OBJECT,
      properties: {
        ...baseRoutingProperties,
        intent: {
          type: Type.STRING,
          description:
            "Specifically for Facebook Comments: 'SALES_DM' (wants info), 'GREET_ONLY' (just praise/thanks), or 'IGNORE' (spam).",
        },
        publicContent: {
          type: Type.STRING,
          description:
            "Short, friendly greeting for a public post. Tailored to user's comment.",
        },
        privateContent: {
          type: Type.STRING,
          description:
            "Detailed, value-heavy response for a private DM. Prices, details, links. Required for SALES_DM.",
        },
      },
      required: [
        "action",
        "reasoning",
        "intent",
        "publicContent",
        "privateContent",
        "requiresGrounding",
        "grounded",
        "usedChunkTypes",
      ],
    };
  }

  return {
    type: Type.OBJECT,
    properties: {
      ...baseRoutingProperties,
      content: {
        type: Type.STRING,
        description: "Standard response content for direct chats.",
      },
    },
    required: [
      "action",
      "reasoning",
      "content",
      "requiresGrounding",
      "grounded",
      "usedChunkTypes",
    ],
  };
}

export const buildDynamicProperties = (mapping: any): Record<string, any> => {
  const props: Record<string, any> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!isAiWritableFieldRule(value)) continue;

    if (typeof value === "object" && value !== null) {
      const mappedType = String((value as any).type).toUpperCase();
      const description = String(
        (value as any).description ||
          (mappedType === "OBJECT" ? `Details for ${key}` : `The ${key}`),
      );

      if (mappedType === "ARRAY") {
        const itemConfig = (value as any).items || {};
        const itemProperties =
          typeof itemConfig === "object" &&
          itemConfig !== null &&
          !Array.isArray(itemConfig)
            ? buildDynamicProperties(
                (itemConfig as any).properties || itemConfig,
              )
            : {};
        const itemRequired =
          typeof itemConfig === "object" &&
          itemConfig !== null &&
          !Array.isArray(itemConfig)
            ? collectRequiredFields(
                (itemConfig as any).properties || itemConfig,
                false,
              )
            : [];
        props[key] = {
          type: Type.ARRAY,
          description,
          items: {
            type: Type.OBJECT,
            properties: itemProperties,
            ...(itemRequired.length > 0 ? { required: itemRequired } : {}),
          },
        };
      } else if (mappedType === "NUMBER" || mappedType === "INTEGER") {
        props[key] = {
          type: mappedType === "INTEGER" ? Type.INTEGER : Type.NUMBER,
          description,
        };
      } else if (mappedType === "BOOLEAN") {
        props[key] = {
          type: Type.BOOLEAN,
          description,
        };
      } else if (mappedType === "STRING") {
        props[key] = {
          type: Type.STRING,
          description,
        };
      } else if (mappedType === "OBJECT") {
        const nestedContent = (value as any).properties || {};
        const nestedProps = buildDynamicProperties(nestedContent);
        const nestedRequired = collectRequiredFields(nestedContent, false);

        props[key] = {
          type: Type.OBJECT,
          description,
          properties: nestedProps,
          ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
        };
      } else {
        throw new Error(
          `Unsupported AI schema field type "${mappedType}" for "${key}"`,
        );
      }
    }
  }
  return props;
};

function isFixedFieldRule(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return String(rule.type ?? "").toUpperCase() === "FIXED";
}

function getFieldSource(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "USER_PROVIDED";
  }
  const rule = value as Record<string, unknown>;
  if (String(rule.type ?? "").toUpperCase() === "FIXED") return "FIXED";
  return String(rule.source ?? "USER_PROVIDED").toUpperCase();
}

function isAiWritableFieldRule(value: unknown): boolean {
  const source = getFieldSource(value);
  return source === "USER_PROVIDED" || source === "AI_DERIVED";
}

function collectRequiredFields(
  mapping: any,
  defaultRequired: boolean,
): string[] {
  if (!mapping || typeof mapping !== "object") return [];
  const required: string[] = [];

  for (const [key, value] of Object.entries(mapping)) {
    if (!isAiWritableFieldRule(value)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const requiredFlag = (value as any).required;
      if (
        requiredFlag === true ||
        (requiredFlag !== false && defaultRequired)
      ) {
        required.push(key);
      }
    }
  }

  return required;
}

export const DEFAULT_CUSTOMER_DETAILS_INSTRUCTIONS =
  "Saves useful customer details to the local customer profile only. Call this ONLY when the customer provides contact details, asks for follow-up, wants to proceed, gives a preference or requirement, or explicitly corrects previously saved details. Do not call it for greetings, generic questions, or identical details already saved in the conversation.";

export function buildSaveCustomerDetailsTool(
  fieldMapping: any,
  customInstructions?: string,
): Tool[] {
  const properties: Record<string, any> = {
    name: {
      type: Type.STRING,
      description: "The customer's real name, if provided.",
    },
    email: {
      type: Type.STRING,
      description: "The customer's email address, if provided.",
    },
    phone: {
      type: Type.STRING,
      description: "The customer's phone number, if provided.",
    },
    notes: {
      type: Type.STRING,
      description:
        "A concise summary of the customer's request, preferences, or next step.",
    },
  };

  if (
    fieldMapping &&
    typeof fieldMapping === "object" &&
    Object.keys(fieldMapping).length > 0
  ) {
    const dynamicMapping: Record<string, any> = {};
    for (const [key, value] of Object.entries(fieldMapping)) {
      if (isAiWritableFieldRule(value)) {
        dynamicMapping[key] = value;
      }
    }

    for (const [key, propConfig] of Object.entries(
      buildDynamicProperties(dynamicMapping),
    )) {
      properties[key] = propConfig;
    }
  }

  return [
    {
      functionDeclarations: [
        {
          name: "save_customer_details",
          description:
            customInstructions || DEFAULT_CUSTOMER_DETAILS_INSTRUCTIONS,
          parameters: {
            type: Type.OBJECT,
            properties,
          },
        },
      ],
    },
  ];
}

export function buildIntegrationActionTools(dataSources: any[]): Tool[] {
  if (!dataSources || dataSources.length === 0) return [];

  const functionDeclarations = dataSources.flatMap((ds) => {
    let properties: any = {};
    try {
      if (
        ds.expectedParamsSchema &&
        typeof ds.expectedParamsSchema === "object"
      ) {
        properties = buildDynamicProperties(ds.expectedParamsSchema);
      }
    } catch (error: any) {
      logger.warn("ai.external_tool.invalid_schema_skipped", {
        sourceId: ds.id,
        sourceName: ds.name,
        error: error?.message || String(error),
      });
      return [];
    }
    const hasDeclaredParams = Object.keys(properties).length > 0;
    const required = collectRequiredFields(ds.expectedParamsSchema, false);
    const actionType = String(ds.actionType || "LOOKUP").toUpperCase();
    const isMutation = actionType === "MUTATION";

    return [{
      name: `integration_action_${ds.id}`,
      description: [
        isMutation
          ? `Chat-requested business action for "${ds.name}". Calling this queues the action in the background.`
          : `Chat-requested information action for "${ds.name}". Calling this queues the check in the background.`,
        ds.description ||
          "Use only when this action directly matches the user's latest request.",
        "Do not call for greetings, generic support, customer detail saving, handoff, or conversation closing.",
        hasDeclaredParams
          ? "If required details are missing, ask the customer for them instead of inventing parameters."
          : "This action requires no customer-supplied parameters; call it with an empty argument object only when the user's request directly needs this action.",
        isMutation
          ? "Do not confirm completion from the queue result. Confirm only after a later verified action result is available."
          : "Do not answer the factual request from the queue result. Answer only after a later verified action result is available.",
      ].join(" "),
      parameters: {
        type: Type.OBJECT,
        properties: hasDeclaredParams ? properties : {},
        ...(required.length > 0 ? { required } : {}),
      },
    }];
  });

  return [{ functionDeclarations }];
}

async function embedTexts(
  texts: string[],
): Promise<{ embeddings: number[][]; totalTokens: number }> {
  const EMBEDDING_CONCURRENCY = 5;

  const embedSingle = async (t: string) => {
    const { result: res } = await executeWithFallback(
      async (model) => {
        return (await genAI.models.embedContent({
          model,
          contents: t,
          config: {
            taskType: "RETRIEVAL_DOCUMENT",
            outputDimensionality: 768,
          },
        })) as EmbedResponseWithUsage;
      },
      "EmbedTexts",
      undefined,
      ["gemini-embedding-001"],
    );

    return {
      embedding: res.embeddings![0].values!,
      tokens: res.usageMetadata?.totalTokenCount ?? 0,
    };
  };

  const results: { embedding: number[]; tokens: number }[] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_CONCURRENCY) {
    const batch = texts.slice(i, i + EMBEDDING_CONCURRENCY);
    results.push(...(await Promise.all(batch.map(embedSingle))));
  }

  return {
    embeddings: results.map((r) => r.embedding),
    totalTokens: results.reduce((sum, r) => sum + r.tokens, 0),
  };
}

async function embedQuery(
  text: string,
): Promise<{ vector: number[]; totalTokens: number }> {
  if (!text || text.trim().length === 0) {
    return { vector: new Array(768).fill(0), totalTokens: 0 };
  }

  const { result: res } = await executeWithFallback(
    async (model) => {
      return (await genAI.models.embedContent({
        model,
        contents: text,
        config: {
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: 768,
        },
      })) as EmbedResponseWithUsage;
    },
    "EmbedQuery",
    undefined,
    ["gemini-embedding-001"],
  );

  return {
    vector: res.embeddings![0].values!,
    totalTokens: res.usageMetadata?.totalTokenCount ?? 0,
  };
}

export async function generateVisualContent(params: {
  prompt: string;
  imageBuffer?: Buffer;
  brandLogoBuffer?: Buffer;
  mimeType?: string;
  brandLogoMimeType?: string;
  onRetry?: (msg: string) => void;
  aspectRatio?: string;
}): Promise<{ imageBuffer: Buffer; usage: AiUsageMetadata }> {
  const parts: GeminiPart[] = [{ text: params.prompt }];

  if (params.imageBuffer) {
    parts.push({
      inlineData: {
        data: params.imageBuffer.toString("base64"),
        mimeType: params.mimeType || "image/png",
      },
    });
  }

  if (params.brandLogoBuffer) {
    parts.push({
      inlineData: {
        data: params.brandLogoBuffer.toString("base64"),
        mimeType: params.brandLogoMimeType || "image/png",
      },
    });
  }

  const { result: response, model } = await executeWithFallback(
    async (model) => {
      return await genAI.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        },
      });
    },
    "VisualGeneration",
    params.onRetry,
    [MODELS.IMAGE_GEN, MODELS.PRIMARY],
  );

  const usage = response.usageMetadata;
  const imagePart = response.candidates?.[0]?.content?.parts?.find(
    (p: any) => p.inlineData || p.fileData,
  ) as
    | { inlineData?: { data: string }; fileData?: { data: string } }
    | undefined;

  if (!imagePart || (!imagePart.inlineData && !imagePart.fileData)) {
    throw new AppError(
      "AI Visual Generation Failed: No image data received",
      502,
    );
  }

  const base64Data = imagePart.inlineData?.data || imagePart.fileData?.data;
  if (!base64Data) {
    throw new AppError("AI Visual Generation Failed: Buffer empty", 502);
  }

  return {
    imageBuffer: Buffer.from(base64Data, "base64"),
    usage: {
      promptTokens: usage?.promptTokenCount || 0,
      completionTokens: usage?.candidatesTokenCount || 0,
      totalTokens: usage?.totalTokenCount || 0,
      groundingCalls: 0,
      model,
    },
  };
}

export { generateContent, generateContentStream, embedTexts, embedQuery };
