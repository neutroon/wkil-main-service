import { z } from "zod";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { GoogleGenAI } from "@google/genai";
import { env } from "@config/env";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";
import {
  getPipelineConfig,
  type PipelineKey,
  type PipelineRuntimeConfig,
} from "@modules/admin/ai-pipeline/ai-pipeline.service";
import type {
  ChatTier,
  AiModelProvider,
} from "@modules/admin/ai-model/ai-model.service";

/**
 * Unified AI pipeline runtime.
 *
 * Every non-chat surface in the platform (content, follow-up, business
 * analysis, memory capture, image generation, embeddings, ...) routes
 * through one of the functions here. Each function:
 *   1. Resolves the configured tier list for its pipeline (DB → env → hardcoded
 *      fallback, see `getPipelineConfig`).
 *   2. Iterates tiers in order; for each tier builds the right provider client
 *      (LangChain chat model, OpenAI embeddings, DALL-E, or @google/genai).
 *   3. Retries on transient provider errors, falls back to the next tier on
 *      hard failures.
 *   4. Tracks usage in a uniform shape so billing can record it downstream.
 *
 * Provider-locked surfaces (e.g. Anthropic has no embeddings API, only Google
 * has Imagen) skip tiers whose provider doesn't support the operation and
 * surface a clear `AI_PROVIDER_UNSUPPORTED` error if no eligible tier remains.
 *
 * Schema contract: any Zod schema passed to `invokePipelineStructured` MUST be
 * OpenAI-strict-mode compliant — every property in `required`, every object
 * with `additionalProperties: false`. See `agentDecision.schema.ts` and
 * the `assertOpenAIStrictCompliant` helper in
 * `agentDecision.schema.test.ts` for the contract. Zod v4's
 * `toJSONSchema` (called by LangChain) handles `additionalProperties: false`
 * automatically; you only need to use `.nullable()` (kept in `required`)
 * instead of `.optional()` (omitted from `required`).
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const EMBEDDING_DIMENSIONS = 768; // pinned by the pgvector column (vector(768))

// ── Usage shape ──────────────────────────────────────────────────────────────
export type PipelineUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  groundingCalls: number;
  model: string;
  provider: AiModelProvider;
};

// ── Shared tier iterator ─────────────────────────────────────────────────────
type TierExecutionContext = {
  tiers: ChatTier[];
  defaultMaxOutputTokens: number | null;
  pipelineKey: PipelineKey;
};

async function resolveContext(pipeline: PipelineKey): Promise<TierExecutionContext> {
  const config: PipelineRuntimeConfig = await getPipelineConfig(pipeline);
  return {
    tiers: config.tiers,
    defaultMaxOutputTokens: config.maxOutputTokens,
    pipelineKey: pipeline,
  };
}

function isRetryable(error: any): boolean {
  const message = String(error?.message || error || "").toLowerCase();
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

function parseProviderError(error: any): string {
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

async function executeWithTierFallback<T>(params: {
  ctx: TierExecutionContext;
  operationName: string;
  supportsProvider: (provider: AiModelProvider, modelId: string) => boolean;
  invoke: (tier: ChatTier) => Promise<{ result: T; model: string }>;
  timeoutMs: number;
}): Promise<{ result: T; tier: ChatTier }> {
  const eligibleTiers = params.ctx.tiers.filter((t) =>
    params.supportsProvider(t.provider, t.modelId),
  );
  if (eligibleTiers.length === 0) {
    throw new AppError(
      `No configured AI model for pipeline "${params.ctx.pipelineKey}" supports this operation (all tiers are dormant, have no API key, or don't support the operation).`,
      500,
      true,
      "AI_NO_ELIGIBLE_TIER",
    );
  }

  let lastError: any;
  for (let i = 0; i < eligibleTiers.length; i++) {
    const tier = eligibleTiers[i];
    let attempt = 0;
    while (attempt < 2) {
      const controller = new AbortController();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          controller.abort("MODEL_TIMEOUT");
          reject(new Error("MODEL_TIMEOUT"));
        }, params.timeoutMs);
      });
      try {
        const { result, model } = await Promise.race([
          params.invoke(tier),
          timeoutPromise,
        ]);
        return { result, tier: { ...tier, modelId: model } };
      } catch (error: any) {
        lastError = error;
        if (controller.signal.aborted) throw new AppError("AI call timed out", 504);
        const retryable = isRetryable(error);
        if (retryable && attempt === 0) {
          attempt++;
          const delay = 400 + Math.random() * 300;
          logger.warn("ai.pipeline.retrying", {
            pipeline: params.ctx.pipelineKey,
            model: tier.modelId,
            provider: tier.provider,
            delayMs: Math.round(delay),
            error: parseProviderError(error),
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (i < eligibleTiers.length - 1) {
          logger.warn("ai.pipeline.fallback", {
            pipeline: params.ctx.pipelineKey,
            model: tier.modelId,
            provider: tier.provider,
            nextModel: eligibleTiers[i + 1].modelId,
            nextProvider: eligibleTiers[i + 1].provider,
            retryable,
            error: parseProviderError(error),
          });
          break;
        }
        const message = parseProviderError(error);
        logger.error("ai.pipeline.final_failure", {
          pipeline: params.ctx.pipelineKey,
          model: tier.modelId,
          provider: tier.provider,
          error: message,
        });
        throw new AppError(message, 502);
      }
    }
  }
  throw lastError;
}

// ── LangChain chat-model factory (shared with modelRuntime) ──────────────────
function apiKeyFor(provider: AiModelProvider): string | null {
  switch (provider) {
    case "google":
      return env.GEMINI_API_KEY || null;
    case "openai":
      return env.OPENAI_API_KEY || null;
    case "anthropic":
      return env.ANTHROPIC_API_KEY || null;
    default:
      return null;
  }
}

function buildChatModel(tier: ChatTier, opts: {
  temperature?: number;
  maxOutputTokens?: number;
}): BaseChatModel {
  const key = apiKeyFor(tier.provider);
  if (!key) {
    throw new AppError(
      `Provider ${tier.provider} is not configured (missing ${tier.provider.toUpperCase()}_API_KEY)`,
      500,
      true,
      "AI_PROVIDER_NOT_CONFIGURED",
    );
  }
  const temperature = opts.temperature ?? 0.4;
  const ceiling = opts.maxOutputTokens ?? env.AI_CHAT_FALLBACK_MAX_OUTPUT_TOKENS;
  switch (tier.provider) {
    case "google":
      return new ChatGoogleGenerativeAI({
        model: tier.modelId,
        apiKey: key,
        temperature,
        maxOutputTokens: ceiling,
      });
    case "openai":
      return new ChatOpenAI({
        model: tier.modelId,
        apiKey: key,
        temperature,
        maxTokens: ceiling,
      });
    case "anthropic":
      return new ChatAnthropic({
        model: tier.modelId,
        apiKey: key,
        temperature,
        maxTokens: ceiling,
      });
    default: {
      const _exhaustive: never = tier.provider;
      throw new AppError(`Unsupported provider ${String(_exhaustive)}`, 500, true);
    }
  }
}

// ── Usage readers (per-provider, then normalised) ────────────────────────────
function readLangChainUsage(message: any, provider: AiModelProvider, model: string): PipelineUsage {
  const usage =
    message?.usage_metadata ||
    message?.usageMetadata ||
    message?.response_metadata?.usage_metadata ||
    message?.response_metadata?.usageMetadata ||
    {};
  return {
    promptTokens: usage.input_tokens ?? usage.promptTokens ?? usage.promptTokenCount ?? usage.inputTokens ?? 0,
    completionTokens: usage.output_tokens ?? usage.completionTokens ?? usage.candidatesTokenCount ?? usage.outputTokens ?? 0,
    totalTokens: usage.total_tokens ?? usage.totalTokens ?? 0,
    groundingCalls: usage.groundingCalls ?? 0,
    model,
    provider,
  };
}

function readGenAITextUsage(response: any, model: string, provider: AiModelProvider): PipelineUsage {
  const usage = response.usageMetadata;
  const grounding = response.candidates?.[0]?.groundingMetadata?.searchEntryPoint;
  return {
    promptTokens: usage?.promptTokenCount || 0,
    completionTokens: usage?.candidatesTokenCount || 0,
    totalTokens: usage?.totalTokenCount || 0,
    groundingCalls: grounding ? 1 : 0,
    model,
    provider,
  };
}

// ── invokePipelineText ───────────────────────────────────────────────────────
export type InvokePipelineTextParams = {
  pipeline: PipelineKey;
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  enableSearch?: boolean; // Google-only grounding; ignored for other providers
  timeoutMs?: number;
};

export async function invokePipelineText(
  params: InvokePipelineTextParams,
): Promise<{ text: string; usage: PipelineUsage }> {
  const ctx = await resolveContext(params.pipeline);
  const { result } = await executeWithTierFallback({
    ctx,
    operationName: `pipeline.${params.pipeline}.text`,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    supportsProvider: (p) => p === "google" || p === "openai" || p === "anthropic",
    invoke: async (tier) => {
      if (tier.provider === "google") {
        // Use the Google GenAI SDK directly to honour grounding
        // (`tools: [{ googleSearch: {} }]`) which LangChain's Gemini wrapper
        // does not expose yet.
        const key = apiKeyFor("google");
        if (!key) throw new AppError("GEMINI_API_KEY missing", 500, true);
        const genai = new GoogleGenAI({ apiKey: key });
        const result = await genai.models.generateContent({
          model: tier.modelId,
          contents: [
            {
              role: "user",
              parts: [{ text: params.systemInstruction ? `${params.systemInstruction}\n\n${params.prompt}` : params.prompt }],
            },
          ],
          config: {
            temperature: params.temperature ?? 0.4,
            responseMimeType: params.enableSearch ? "text/plain" : "text/plain",
            tools: params.enableSearch ? [{ googleSearch: {} }] : undefined,
            maxOutputTokens: params.maxOutputTokens ?? ctx.defaultMaxOutputTokens ?? env.AI_CHAT_FALLBACK_MAX_OUTPUT_TOKENS,
          },
        });
        return { result, model: tier.modelId };
      }
      const llm = buildChatModel(tier, {
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens ?? ctx.defaultMaxOutputTokens ?? undefined,
      });
      const messages = params.systemInstruction
        ? [
            { role: "system" as const, content: params.systemInstruction },
            { role: "user" as const, content: params.prompt },
          ]
        : [{ role: "user" as const, content: params.prompt }];
      const message = await (llm as any).invoke(messages);
      return { result: message, model: tier.modelId };
    },
  });

  if (result instanceof Object && "content" in result) {
    // LangChain message
    const lcMsg = result as any;
    const text =
      typeof lcMsg.content === "string"
        ? lcMsg.content
        : Array.isArray(lcMsg.content)
          ? lcMsg.content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("")
          : "";
    return {
      text,
      usage: readLangChainUsage(lcMsg, "openai", lcMsg.response_metadata?.model_name || ""),
    };
  }
  // Google GenAI response
  const genMsg = result as any;
  return {
    text: genMsg.text || "",
    usage: readGenAITextUsage(genMsg, genMsg.modelVersion || "", "google"),
  };
}

// ── invokePipelineTextStream (async iterator of text chunks) ─────────────────
export type InvokePipelineTextStreamParams = Omit<InvokePipelineTextParams, "maxOutputTokens"> & {
  maxOutputTokens?: number;
};
export type StreamChunk = { text: string; usage?: PipelineUsage; done: boolean };

export async function* invokePipelineTextStream(
  params: InvokePipelineTextStreamParams,
): AsyncGenerator<StreamChunk> {
  const ctx = await resolveContext(params.pipeline);
  const tiers = ctx.tiers;
  if (tiers.length === 0) {
    throw new AppError(`No tiers for pipeline ${params.pipeline}`, 500, true);
  }
  // Stream falls back per-tier only on hard failure; partial streams are
  // delivered as-is (LangChain / OpenAI / Anthropic all return a single
  // AsyncIterable that can be terminated by the caller).
  let lastError: any;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    try {
      if (tier.provider === "google") {
        const key = apiKeyFor("google");
        if (!key) throw new AppError("GEMINI_API_KEY missing", 500, true);
        const genai = new GoogleGenAI({ apiKey: key });
        const stream = await genai.models.generateContentStream({
          model: tier.modelId,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: params.systemInstruction
                    ? `${params.systemInstruction}\n\n${params.prompt}`
                    : params.prompt,
                },
              ],
            },
          ],
          config: {
            temperature: params.temperature ?? 0.4,
            responseMimeType: params.enableSearch ? "text/plain" : "text/plain",
            tools: params.enableSearch ? [{ googleSearch: {} }] : undefined,
            maxOutputTokens:
              params.maxOutputTokens ?? ctx.defaultMaxOutputTokens ?? env.AI_CHAT_FALLBACK_MAX_OUTPUT_TOKENS,
          },
        });
        let buffer = "";
        for await (const chunk of stream as any) {
          const text = chunk.text || "";
          buffer += text;
          yield { text, done: false };
        }
        const finalUsage = (stream as any).response?.usageMetadata;
        yield {
          text: "",
          usage: {
            promptTokens: finalUsage?.promptTokenCount || 0,
            completionTokens: finalUsage?.candidatesTokenCount || 0,
            totalTokens: finalUsage?.totalTokenCount || 0,
            groundingCalls: 0,
            model: tier.modelId,
            provider: "google",
          },
          done: true,
        };
        return;
      }
      // Non-Google streaming via LangChain
      const llm = buildChatModel(tier, {
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens ?? ctx.defaultMaxOutputTokens ?? undefined,
      });
      const messages = params.systemInstruction
        ? [
            { role: "system" as const, content: params.systemInstruction },
            { role: "user" as const, content: params.prompt },
          ]
        : [{ role: "user" as const, content: params.prompt }];
      const stream = await (llm as any).stream(messages);
      let lastMessage: any = null;
      for await (const chunk of stream) {
        lastMessage = chunk;
        const text =
          typeof chunk.content === "string"
            ? chunk.content
            : Array.isArray(chunk.content)
              ? chunk.content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("")
              : "";
        yield { text, done: false };
      }
      yield {
        text: "",
        usage: readLangChainUsage(lastMessage, tier.provider, tier.modelId),
        done: true,
      };
      return;
    } catch (error: any) {
      lastError = error;
      if (i < tiers.length - 1) {
        logger.warn("ai.pipeline.stream_fallback", {
          pipeline: params.pipeline,
          model: tier.modelId,
          provider: tier.provider,
          nextModel: tiers[i + 1].modelId,
          error: parseProviderError(error),
        });
        continue;
      }
      throw new AppError(parseProviderError(error), 502);
    }
  }
  throw lastError;
}

// ── invokePipelineStructured (Zod-validated JSON output) ────────────────────
export type InvokePipelineStructuredParams<T> = {
  pipeline: PipelineKey;
  schema: z.ZodType<T>;
  schemaName: string;
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  enableSearch?: boolean; // Google-only grounding
  timeoutMs?: number;
};

export async function invokePipelineStructured<T>(
  params: InvokePipelineStructuredParams<T>,
): Promise<{ result: T; usage: PipelineUsage; raw: string }> {
  const ctx = await resolveContext(params.pipeline);
  const { result } = await executeWithTierFallback({
    ctx,
    operationName: `pipeline.${params.pipeline}.structured.${params.schemaName}`,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    supportsProvider: (p) => p === "google" || p === "openai" || p === "anthropic",
    invoke: async (tier) => {
      const llm = buildChatModel(tier, {
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens ?? ctx.defaultMaxOutputTokens ?? undefined,
      });
      const messages = params.systemInstruction
        ? [
            { role: "system" as const, content: params.systemInstruction },
            { role: "user" as const, content: params.prompt },
          ]
        : [{ role: "user" as const, content: params.prompt }];
      const structured = (llm as any).withStructuredOutput(params.schema, {
        name: params.schemaName,
        includeRaw: true,
      });
      const out = await structured.invoke(messages);
      return { result: out, model: tier.modelId };
    },
  });

  const raw = result?.raw;
  const parsed =
    result && typeof result === "object" && "parsed" in result
      ? result.parsed
      : result;
  const validated = params.schema.parse(parsed);
  const rawMessage = raw;
  const text =
    rawMessage && rawMessage.content
      ? typeof rawMessage.content === "string"
        ? rawMessage.content
        : Array.isArray(rawMessage.content)
          ? rawMessage.content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("")
          : JSON.stringify(validated)
      : JSON.stringify(validated);

  return {
    result: validated,
    raw: text,
    usage: readLangChainUsage(rawMessage, "openai", rawMessage?.response_metadata?.model_name || ""),
  };
}

// ── invokePipelineEmbedding (multi-provider with 768-dim enforcement) ───────
export type InvokePipelineEmbeddingParams = {
  pipeline: PipelineKey;
  texts: string[];
  timeoutMs?: number;
};

export type EmbeddingResult = {
  embeddings: number[][];
  usage: PipelineUsage;
};

// OpenAI's text-embedding-3-* family supports a `dimensions` parameter to
// pin the output size. Older models (ada-002) do not.
function openAiSupportsDimensions(modelId: string): boolean {
  return modelId.startsWith("text-embedding-3");
}

export async function invokePipelineEmbedding(
  params: InvokePipelineEmbeddingParams,
): Promise<EmbeddingResult> {
  const ctx = await resolveContext(params.pipeline);
  // Anthropic has no embeddings API — skip those tiers with a clear error
  // if every eligible tier is Anthropic.
  const eligible = ctx.tiers.filter(
    (t) => t.provider === "google" || (t.provider === "openai" && openAiSupportsDimensions(t.modelId)),
  );
  if (eligible.length === 0) {
    throw new AppError(
      `No embedding-capable model for pipeline "${params.pipeline}". Need either a Google embedding model or an OpenAI text-embedding-3-* model.`,
      500,
      true,
      "AI_NO_EMBEDDING_TIER",
    );
  }

  let lastError: any;
  for (let i = 0; i < eligible.length; i++) {
    const tier = eligible[i];
    try {
      if (tier.provider === "google") {
        const key = apiKeyFor("google");
        if (!key) throw new AppError("GEMINI_API_KEY missing", 500, true);
        const genai = new GoogleGenAI({ apiKey: key });
        const embeddings: number[][] = [];
        let totalPromptTokens = 0;
        for (const text of params.texts) {
          const res: any = await genai.models.embedContent({
            model: tier.modelId,
            contents: text,
            config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: EMBEDDING_DIMENSIONS },
          });
          embeddings.push(res.embeddings?.[0]?.values ?? []);
          totalPromptTokens += res.usageMetadata?.totalTokenCount ?? 0;
        }
        return {
          embeddings,
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: 0,
            totalTokens: totalPromptTokens,
            groundingCalls: 0,
            model: tier.modelId,
            provider: "google",
          },
        };
      }
      // OpenAI
      const key = apiKeyFor("openai");
      if (!key) throw new AppError("OPENAI_API_KEY missing", 500, true);
      const res: any = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: tier.modelId,
          input: params.texts,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI embeddings ${res.status}: ${errText}`);
      }
      const data: any = await res.json();
      const embeddings: number[][] = data.data.map((d: any) => d.embedding);
      return {
        embeddings,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: 0,
          totalTokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
          groundingCalls: 0,
          model: tier.modelId,
          provider: "openai",
        },
      };
    } catch (error: any) {
      lastError = error;
      if (i < eligible.length - 1) {
        logger.warn("ai.pipeline.embedding_fallback", {
          pipeline: params.pipeline,
          model: tier.modelId,
          provider: tier.provider,
          nextModel: eligible[i + 1].modelId,
          error: parseProviderError(error),
        });
        continue;
      }
      throw new AppError(parseProviderError(error), 502);
    }
  }
  throw lastError;
}

// ── invokePipelineEmbeddingQuery (single query, may use a different model) ─
export async function invokePipelineEmbeddingQuery(
  params: { pipeline: PipelineKey; text: string; timeoutMs?: number },
): Promise<{ vector: number[]; usage: PipelineUsage }> {
  const { embeddings, usage } = await invokePipelineEmbedding({
    pipeline: params.pipeline,
    texts: [params.text],
    timeoutMs: params.timeoutMs,
  });
  return { vector: embeddings[0] ?? [], usage };
}

// ── invokePipelineImageGen (Google Imagen + OpenAI DALL-E 3) ────────────────
export type InvokePipelineImageGenParams = {
  pipeline: PipelineKey;
  prompt: string;
  imageBuffer?: Buffer;
  brandLogoBuffer?: Buffer;
  mimeType?: string;
  brandLogoMimeType?: string;
  aspectRatio?: string;
  timeoutMs?: number;
};

export type ImageGenResult = {
  imageBuffer: Buffer;
  usage: PipelineUsage;
};

export async function invokePipelineImageGen(
  params: InvokePipelineImageGenParams,
): Promise<ImageGenResult> {
  const ctx = await resolveContext(params.pipeline);
  const eligible = ctx.tiers.filter((t) => t.provider === "google" || t.provider === "openai");
  if (eligible.length === 0) {
    throw new AppError(
      `No image-gen capable model for pipeline "${params.pipeline}". Need a Google Imagen or OpenAI DALL-E model.`,
      500,
      true,
      "AI_NO_IMAGEGEN_TIER",
    );
  }

  let lastError: any;
  for (let i = 0; i < eligible.length; i++) {
    const tier = eligible[i];
    try {
      if (tier.provider === "google") {
        const key = apiKeyFor("google");
        if (!key) throw new AppError("GEMINI_API_KEY missing", 500, true);
        const genai = new GoogleGenAI({ apiKey: key });
        const parts: any[] = [{ text: params.prompt }];
        if (params.imageBuffer) {
          parts.push({
            inlineData: { data: params.imageBuffer.toString("base64"), mimeType: params.mimeType || "image/png" },
          });
        }
        if (params.brandLogoBuffer) {
          parts.push({
            inlineData: { data: params.brandLogoBuffer.toString("base64"), mimeType: params.brandLogoMimeType || "image/png" },
          });
        }
        const response: any = await genai.models.generateContent({
          model: tier.modelId,
          contents: [{ role: "user", parts }],
          config: { temperature: 0.7, maxOutputTokens: 2048 },
        });
        const imagePart = response.candidates?.[0]?.content?.parts?.find(
          (p: any) => p.inlineData || p.fileData,
        ) as { inlineData?: { data: string }; fileData?: { data: string } } | undefined;
        if (!imagePart || (!imagePart.inlineData && !imagePart.fileData)) {
          throw new AppError("AI Visual Generation Failed: No image data received", 502);
        }
        const base64Data = imagePart.inlineData?.data || imagePart.fileData?.data;
        if (!base64Data) throw new AppError("AI Visual Generation Failed: Buffer empty", 502);
        return {
          imageBuffer: Buffer.from(base64Data, "base64"),
          usage: readGenAITextUsage(response, tier.modelId, "google"),
        };
      }
      // OpenAI DALL-E 3 — does not support editing / brand logos, only
      // text-to-image. Drop the buffers and synthesise the prompt.
      const key = apiKeyFor("openai");
      if (!key) throw new AppError("OPENAI_API_KEY missing", 500, true);
      const body: any = {
        model: tier.modelId, // e.g. dall-e-3
        prompt: params.prompt,
        n: 1,
        size: params.aspectRatio === "16:9" ? "1792x1024" : params.aspectRatio === "9:16" ? "1024x1792" : "1024x1024",
        response_format: "b64_json",
      };
      const res: any = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI image gen ${res.status}: ${errText}`);
      }
      const data: any = await res.json();
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new AppError("OpenAI returned no image", 502);
      return {
        imageBuffer: Buffer.from(b64, "base64"),
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          groundingCalls: 0,
          model: tier.modelId,
          provider: "openai",
        },
      };
    } catch (error: any) {
      lastError = error;
      if (i < eligible.length - 1) {
        logger.warn("ai.pipeline.imagegen_fallback", {
          pipeline: params.pipeline,
          model: tier.modelId,
          provider: tier.provider,
          nextModel: eligible[i + 1].modelId,
          error: parseProviderError(error),
        });
        continue;
      }
      throw new AppError(parseProviderError(error), 502);
    }
  }
  throw lastError;
}
