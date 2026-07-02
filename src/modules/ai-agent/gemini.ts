import {
  GoogleGenAI,
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
 * Final hardcoded fallback for the text-generation runtime. Used only when the
 * admin-managed AiPipeline registry, the AiModel registry, AND the env fallback
 * tiers are all empty or unreachable. Kept in sync with FALLBACK_CHAT_TIERS in
 * ai-model.service.ts and the seed (prisma/seed-ai-models.ts). Gemini-only by
 * design — this module always talks to the Google GenAI SDK.
 */
const HARDCODED_TEXT_TIERS = [MODELS.PRIMARY, MODELS.RESERVE, MODELS.STABLE];

/**
 * Resolves the model tiers for a given pipeline from the admin-managed
 * AiPipeline registry (cached, never throws). Each AI surface passes its own
 * `pipeline` key so the admin can configure them independently — or set
 * `inheritsChatDefault` to make a surface follow the chat model selection.
 * Defaults to the "chat" pipeline when called without a key.
 *
 * Returns modelId-only strings — the Google GenAI SDK used in this module
 * is provider-locked (Google only), so we project away the provider field
 * from the registry. Multi-provider dispatch lives in modelRuntime.ts.
 */
async function resolveTextTiers(
  pipeline: string = "chat",
): Promise<string[]> {
  try {
    const { getPipelineConfig } = await import(
      "@modules/admin/ai-pipeline/ai-pipeline.service"
    );
    const config = await getPipelineConfig(pipeline as any);
    if (config.tiers.length > 0) {
      return config.tiers.map((t) => t.modelId);
    }
  } catch (error: any) {
    logger.warn("gemini.text_tiers.registry_resolve_failed", {
      pipeline,
      error: error?.message,
    });
  }
  return HARDCODED_TEXT_TIERS;
}

/**
 * Robust execution wrapper with exponential backoff and model failover.
 */
function parseGeminiErrorMessage(error: any): string {
  let message = error?.message || String(error);

  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(message);
      const next = parsed?.error?.message || parsed?.message;
      if (!next || next === message) break;
      message = next;
    } catch {
      break;
    }
  }

  return message;
}

export function isRetryableGeminiError(error: any): boolean {
  const message = parseGeminiErrorMessage(error).toLowerCase();
  const status = Number(error?.status ?? error?.code);

  return (
    status === 503 ||
    status === 429 ||
    message.includes("high demand") ||
    message.includes("unavailable") ||
    message.includes("service unavailable") ||
    message.includes("deadline") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  );
}

function throwIfAborted(abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) {
    throw new Error("GEMINI_TIMEOUT");
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  abortController: AbortController,
): Promise<T> {
  if (!timeoutMs) return promise;

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort("GEMINI_TIMEOUT");
      reject(new Error("GEMINI_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function waitWithAbort(ms: number, abortSignal?: AbortSignal) {
  if (!abortSignal) {
    return new Promise((res) => setTimeout(res, ms));
  }
  const signal = abortSignal;
  if (signal.aborted) {
    return Promise.reject(new Error("GEMINI_TIMEOUT"));
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(cleanupAndResolve, ms);

    function cleanupAndResolve() {
      signal.removeEventListener("abort", cleanupAndReject);
      resolve();
    }

    function cleanupAndReject() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cleanupAndReject);
      reject(new Error("GEMINI_TIMEOUT"));
    }

    signal.addEventListener("abort", cleanupAndReject, { once: true });
  });
}

export async function executeWithFallback<T>(
  operation: (model: string, abortSignal: AbortSignal) => Promise<T>,
  context: string,
  onRetry?: (message: string) => void,
  customTiers?: string[],
  abortSignal?: AbortSignal,
  timeoutMs?: number,
  pipeline?: string,
): Promise<{ result: T; model: string }> {
  // When the caller pins specific models (embeddings, image generation) we use
  // them verbatim. Otherwise resolve from the admin-managed AiPipeline registry
  // so every surface (follow-ups, content, analysis, ...) honours the
  // super_admin-configured model for its own pipeline — or inherits chat when
  // `inheritsChatDefault` is set. The resolver is cached and never throws, so
  // the non-pinned path stays resilient even if the registry/DB is unreachable.
  const tiers = customTiers ?? (await resolveTextTiers(pipeline));
  const deadlineAt = timeoutMs ? Date.now() + timeoutMs : undefined;
  let lastError: any;

  function remainingTimeoutMs(): number | undefined {
    if (!deadlineAt) return undefined;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("GEMINI_TIMEOUT");
    return remainingMs;
  }

  for (let t = 0; t < tiers.length; t++) {
    const currentModel = tiers[t];
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      const attemptAbortController = new AbortController();
      const abortCurrentAttempt = () => attemptAbortController.abort("GEMINI_TIMEOUT");
      abortSignal?.addEventListener("abort", abortCurrentAttempt, { once: true });
      try {
        throwIfAborted(abortSignal);
        const result = await withTimeout(
          operation(currentModel, attemptAbortController.signal),
          remainingTimeoutMs(),
          attemptAbortController,
        );
        return { result, model: currentModel };
      } catch (error: any) {
        lastError = error;
        throwIfAborted(attemptAbortController.signal);
        throwIfAborted(abortSignal);
        const isRetryable = isRetryableGeminiError(error);

        if (isRetryable && attempts < maxAttempts - 1) {
          attempts++;
          // Exponential backoff with jitter (best practice for production resilience)
          const delay = Math.pow(2, attempts) * 1000 + Math.random() * 1000;
          const msg = `[GeminiResilience] ${context} - Model ${currentModel} hit ${error.status || "spike"}. Retrying in ${Math.round(delay)}ms...`;
          logger.warn(msg);
          if (onRetry) onRetry(msg);
          await waitWithAbort(
            Math.min(delay, remainingTimeoutMs() ?? delay),
            abortSignal,
          );
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
        const errorMessage = parseGeminiErrorMessage(error);

        logger.error(`Gemini final failure: ${errorMessage}`);
        throw new AppError(errorMessage, 502);
      }
      finally {
        abortSignal?.removeEventListener("abort", abortCurrentAttempt);
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
  pipeline?: string,
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
    undefined,
    undefined,
    undefined,
    pipeline,
  );
}

async function generateContent(
  prompt: string,
  responseMimeType?: string,
  enableSearch?: boolean,
  onRetry?: (msg: string) => void,
  temperature: number = 0.4,
  pipeline?: string,
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
    undefined,
    undefined,
    undefined,
    pipeline,
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
      undefined,
      undefined,
      "embeddings",
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
  options: { timeoutMs?: number } = {},
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
    undefined,
    options.timeoutMs,
    "embeddings",
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
  pipeline?: string;
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

  // Resolve image tiers from the "image_gen" pipeline (admin-configurable);
  // fall back to the fixed image-capable pair if the registry is unavailable.
  // Project the rich ChatTier[] down to modelId-only strings — this module
  // only talks to the Google GenAI SDK.
  let imageTiers: string[];
  try {
    const { getPipelineConfig } = await import(
      "@modules/admin/ai-pipeline/ai-pipeline.service"
    );
    const config = await getPipelineConfig(
      (params.pipeline as any) ?? "image_gen",
    );
    imageTiers = config.tiers.length > 0
      ? config.tiers.map((t) => t.modelId)
      : [MODELS.IMAGE_GEN, MODELS.PRIMARY];
  } catch (error: any) {
    logger.warn("gemini.image_tiers.resolve_failed", { error: error?.message });
    imageTiers = [MODELS.IMAGE_GEN, MODELS.PRIMARY];
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
    imageTiers,
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
