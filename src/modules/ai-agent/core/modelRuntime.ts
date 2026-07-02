import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { env } from "@config/env";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";
import {
  externalToolRecoveryRouteSchema,
  getAiRoutingDecisionSchemaForChannel,
} from "./agentDecision.schema";
import type {
  AgentContent,
  AgentToolDefinition,
  SessionStats,
  ToolCall,
} from "./agentState";
import type { AiRoutingDecision } from "./aiEngine.utils";
import { repairAndParseAiResponse } from "./aiEngine.utils";
import type { ChatTier, AiModelProvider } from "@modules/admin/ai-model/ai-model.service";

const MODEL_TIMEOUT_MS = 60_000;
// Hardcoded fallback tier order, applied only when both the admin-managed
// AiModel registry AND `env.AI_CHAT_FALLBACK_MODEL_TIERS` are unavailable.
// Exported so the order can be pinned by the unit test. Google-only by
// design — the env var and this constant are disaster-recovery knobs; the
// AiModel DB registry is the only source of non-google models.
export const DEFAULT_MODEL_TIERS: ChatTier[] = [
  { modelId: "gemini-3.1-flash-lite-preview", provider: "google" },
  { modelId: "gemini-3-flash-preview", provider: "google" },
  { modelId: "gemini-2.5-flash", provider: "google" },
];

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  groundingCalls: number;
};

export type ToolChoiceResult = {
  toolCalls: ToolCall[];
  rawText: string;
  usage: ModelUsage;
  modelName: string;
  finishReason: string | null;
};

export type DecisionOrToolResult = ToolChoiceResult;

export type DecisionInvokeResult = {
  decision: AiRoutingDecision;
  rawText: string;
  usage: ModelUsage;
  modelName: string;
  finishReason: string | null;
};

export type TextInvokeResult = {
  text: string;
  usage: ModelUsage;
  modelName: string;
  finishReason: string | null;
};

export class ModelStructuredOutputError extends Error {
  rawText: string;
  usage: ModelUsage;
  modelName: string;
  finishReason: string | null;
  cause?: unknown;

  constructor(params: {
    rawText: string;
    usage: ModelUsage;
    modelName: string;
    finishReason: string | null;
    cause: unknown;
  }) {
    super("MODEL_STRUCTURED_OUTPUT_PARSE_FAILED");
    this.name = "ModelStructuredOutputError";
    this.rawText = params.rawText;
    this.usage = params.usage;
    this.modelName = params.modelName;
    this.finishReason = params.finishReason;
    this.cause = params.cause;
  }
}

export function isModelStructuredOutputError(
  error: unknown,
): error is ModelStructuredOutputError {
  return error instanceof ModelStructuredOutputError;
}

function parseProviderErrorMessage(error: any): string {
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

export function isRetryableProviderError(error: any): boolean {
  const message = parseProviderErrorMessage(error).toLowerCase();
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
  if (abortSignal?.aborted) throw new Error("MODEL_TIMEOUT");
}

function waitWithAbort(ms: number, abortSignal?: AbortSignal) {
  if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms));
  const signal = abortSignal;
  if (signal.aborted) return Promise.reject(new Error("MODEL_TIMEOUT"));

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(cleanupAndResolve, ms);

    function cleanupAndResolve() {
      signal.removeEventListener("abort", cleanupAndReject);
      resolve();
    }

    function cleanupAndReject() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cleanupAndReject);
      reject(new Error("MODEL_TIMEOUT"));
    }

    signal.addEventListener("abort", cleanupAndReject, { once: true });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort("MODEL_TIMEOUT");
      reject(new Error("MODEL_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Per-call context for the chat runtime: the resolved tier list (in
 * fallback order) and the default chat model's per-row `maxOutputTokens`
 * (null if the admin hasn't configured one). Both come from a single
 * cached read of the AiModel registry inside `getChatRuntimeConfig`.
 */
type ChatRuntimeContext = {
  tiers: ChatTier[];
  defaultMaxOutputTokens: number | null;
};

/**
 * Resolves the live chat runtime config (tiers + default maxOutputTokens)
 * from the admin-managed AiModel registry (DB), falling back to env then
 * hardcoded defaults when the registry is empty or the DB is unreachable.
 * The DB layer is cached (5-min TTL) inside the registry service; on failure
 * it degrades gracefully so a chat message is never blocked by a settings
 * outage.
 */
async function resolveChatRuntimeConfig(
  pipeline: string = "chat",
): Promise<ChatRuntimeContext> {
  try {
    // Resolve through the AiPipeline registry (single source of truth). The
    // "chat" pipeline inherits the AiModel chat tiers; other pipelines (e.g.
    // media_understanding) can be configured independently by a super_admin.
    // Dynamic import avoids a circular dependency at module load.
    const { getPipelineConfig } = await import(
      "@modules/admin/ai-pipeline/ai-pipeline.service"
    );
    const config = await getPipelineConfig(pipeline as any);
    if (config.tiers.length > 0) {
      return {
        tiers: config.tiers,
        defaultMaxOutputTokens: config.maxOutputTokens,
      };
    }
  } catch (error: any) {
    logger.warn("ai.model_runtime.registry_resolve_failed", {
      pipeline,
      error: error?.message,
    });
  }
  // Fallback chain: env (comma-separated, google-only) → hardcoded
  // DEFAULT_MODEL_TIERS (google-only). No per-model maxOutputTokens in this
  // branch — env is the only override.
  const envTiers = (env.AI_CHAT_FALLBACK_MODEL_TIERS || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const fallbackTiers: ChatTier[] =
    envTiers.length > 0
      ? envTiers.map((modelId) => ({ modelId, provider: "google" }))
      : DEFAULT_MODEL_TIERS;
  return {
    tiers: fallbackTiers,
    defaultMaxOutputTokens: null,
  };
}

async function executeWithModelFallback<T>(
  operation: (
    tier: ChatTier,
    abortSignal: AbortSignal,
    ctx: ChatRuntimeContext,
  ) => Promise<T>,
  context: string,
  timeoutMs = MODEL_TIMEOUT_MS,
  pipeline: string = "chat",
): Promise<{ result: T; model: string }> {
  const ctx = await resolveChatRuntimeConfig(pipeline);
  const modelTiers = ctx.tiers;
  let lastError: any;

  for (let tierIndex = 0; tierIndex < modelTiers.length; tierIndex++) {
    const tier = modelTiers[tierIndex];
    const model = tier.modelId;
    let attempt = 0;

    while (attempt < 2) {
      const abortController = new AbortController();
      try {
        const result = await withTimeout(
          operation(tier, abortController.signal, ctx),
          timeoutMs,
          abortController,
        );
        return { result, model };
      } catch (error: any) {
        lastError = error;
        throwIfAborted(abortController.signal);
        const retryable = isRetryableProviderError(error);

        if (retryable && attempt === 0) {
          attempt++;
          const delay = 400 + Math.random() * 300;
          logger.warn("ai.model_runtime.retrying", {
            context,
            model,
            provider: tier.provider,
            delayMs: Math.round(delay),
            error: parseProviderErrorMessage(error),
          });
          await waitWithAbort(delay, abortController.signal);
          continue;
        }

        if (tierIndex < modelTiers.length - 1) {
          logger.warn("ai.model_runtime.fallback_model", {
            context,
            model,
            provider: tier.provider,
            nextModel: modelTiers[tierIndex + 1].modelId,
            nextProvider: modelTiers[tierIndex + 1].provider,
            retryable,
            error: parseProviderErrorMessage(error),
          });
          break;
        }

        const message = parseProviderErrorMessage(error);
        logger.error("ai.model_runtime.final_failure", {
          context,
          model,
          provider: tier.provider,
          error: message,
        });
        throw new AppError(message, 502);
      }
    }
  }

  throw lastError;
}

/**
 * Returns the env API key for a provider, or null if not configured. The
 * tier resolver in ai-model.service.ts already filters out unconfigured
 * providers, so reaching this with a missing key is a configuration drift
 * (cache stale, env rotated) — we surface it as a clear AppError instead
 * of letting the SDK send an undefined key and produce a confusing 401.
 */
function apiKeyForProvider(provider: AiModelProvider): string | null {
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

/**
 * Build a LangChain chat model for a given provider. Each provider's SDK
 * uses a different parameter name for the output ceiling:
 *   - Gemini  : maxOutputTokens
 *   - OpenAI  : maxTokens (ChatOpenAI also handles the o1/o3/gpt-5 family
 *               automatically by mapping to maxCompletionTokens)
 *   - Anthropic: maxTokens
 * We normalise the per-call ceiling to `maxOutputTokens` in our API and
 * rename per provider here so the rest of the runtime can stay provider-
 * agnostic.
 */
function createChatModel(params: {
  tier: ChatTier;
  temperature?: number;
  maxOutputTokens?: number;
}): BaseChatModel {
  const { tier } = params;
  const apiKey = apiKeyForProvider(tier.provider);
  if (!apiKey) {
    throw new AppError(
      `Provider ${tier.provider} is not configured (missing ${tier.provider.toUpperCase()}_API_KEY in env) for model ${tier.modelId}`,
      500,
      true,
      "AI_PROVIDER_NOT_CONFIGURED",
    );
  }

  const temperature = params.temperature ?? 0.4;
  const ceiling = params.maxOutputTokens ?? env.AI_CHAT_FALLBACK_MAX_OUTPUT_TOKENS;

  switch (tier.provider) {
    case "google":
      return new ChatGoogleGenerativeAI({
        model: tier.modelId,
        apiKey,
        temperature,
        maxOutputTokens: ceiling,
      });
    case "openai":
      return new ChatOpenAI({
        model: tier.modelId,
        apiKey,
        temperature,
        maxTokens: ceiling,
      });
    case "anthropic":
      return new ChatAnthropic({
        model: tier.modelId,
        apiKey,
        temperature,
        maxTokens: ceiling,
      });
    default: {
      // Exhaustiveness guard — if a new provider is added to the enum this
      // fails to compile, prompting an update here too.
      const _exhaustive: never = tier.provider;
      throw new AppError(
        `Unsupported AI provider: ${String(_exhaustive)}`,
        500,
        true,
        "AI_PROVIDER_UNSUPPORTED",
      );
    }
  }
}

function toLangChainMessages(contents: AgentContent[], systemInstruction?: string) {
  const messages: any[] = [];
  if (systemInstruction) messages.push(new SystemMessage(systemInstruction));

  for (const turn of contents) {
    if (turn.role === "user") {
      messages.push(new HumanMessage(userContentForLangChain(turn)));
      continue;
    }

    if (turn.role === "tool") {
      messages.push(
        new ToolMessage({
          content: turn.content || JSON.stringify(turn.toolResult ?? {}),
          tool_call_id: turn.toolCallId || turn.toolName || "tool_call",
          name: turn.toolName,
        } as any),
      );
      continue;
    }

    messages.push(
      new AIMessage({
        content: turn.content || "",
        tool_calls: turn.toolCalls?.map((call) => ({
          id: call.id || call.name,
          name: call.name,
          args: call.args || {},
        })),
      } as any),
    );
  }

  return messages;
}

function userContentForLangChain(turn: AgentContent): any {
  if (!turn.inlineData) return turn.content || "";

  const parts: any[] = [];
  if (turn.content) parts.push({ type: "text", text: turn.content });

  if (turn.inlineData.mimeType.startsWith("image/")) {
    parts.push({
      type: "image_url",
      image_url: `data:${turn.inlineData.mimeType};base64,${turn.inlineData.data}`,
    });
  } else {
    parts.push({
      type: "text",
      text: `[Unsupported inline media: ${turn.inlineData.mimeType}]`,
    });
  }

  return { content: parts };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as any).text === "string") {
        return (part as any).text;
      }
      return "";
    })
    .join("");
}

function readUsage(message: any): ModelUsage {
  const usage =
    message?.usage_metadata ||
    message?.usageMetadata ||
    message?.response_metadata?.usage_metadata ||
    message?.response_metadata?.usageMetadata ||
    {};

  return {
    promptTokens:
      usage.input_tokens ??
      usage.promptTokens ??
      usage.promptTokenCount ??
      usage.inputTokens ??
      0,
    completionTokens:
      usage.output_tokens ??
      usage.completionTokens ??
      usage.candidatesTokenCount ??
      usage.outputTokens ??
      0,
    groundingCalls: usage.groundingCalls ?? 0,
  };
}

function readFinishReason(message: any): string | null {
  const reason =
    message?.response_metadata?.finishReason ||
    message?.response_metadata?.finish_reason ||
    message?.additional_kwargs?.finishReason ||
    message?.additional_kwargs?.finish_reason;
  return typeof reason === "string" && reason.trim()
    ? reason.trim().toUpperCase()
    : null;
}

function readToolCalls(message: any): ToolCall[] {
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls
    : Array.isArray(message?.toolCalls)
      ? message.toolCalls
      : [];

  return toolCalls
    .filter((call: any) => typeof call?.name === "string")
    .map((call: any) => ({
      id: call.id || `${call.name}_${Date.now()}`,
      name: call.name,
      args: call.args || {},
    }));
}

export function addUsageToSessionStats(
  stats: SessionStats,
  usage: ModelUsage,
  modelName: string,
): SessionStats {
  return {
    ...stats,
    modelName,
    promptTokens: stats.promptTokens + usage.promptTokens,
    completionTokens: stats.completionTokens + usage.completionTokens,
    groundingCalls: stats.groundingCalls + usage.groundingCalls,
  };
}

export async function invokeDecisionOrTool(params: {
  systemInstruction: string;
  contents: AgentContent[];
  tools: AgentToolDefinition[];
  temperature?: number;
  timeoutMs?: number;
}): Promise<DecisionOrToolResult> {
  const messages = toLangChainMessages(
    params.contents,
    buildDecisionOrToolSystemInstruction(params.systemInstruction),
  );

  const { result: message, model } = await executeWithModelFallback<any>(
    (tier, abortSignal, ctx) => {
      const llm = createChatModel({
        tier,
        temperature: params.temperature ?? 0.4,
        maxOutputTokens: ctx.defaultMaxOutputTokens ?? undefined,
      }) as any;
      return llm.bindTools(params.tools as any).invoke(messages, { signal: abortSignal } as any);
    },
    "AgentGraph.callModel.decisionOrTool",
    params.timeoutMs,
  );

  return {
    toolCalls: readToolCalls(message),
    rawText: contentToText(message.content),
    usage: readUsage(message),
    modelName: model,
    finishReason: readFinishReason(message),
  };
}

export function buildDecisionOrToolSystemInstruction(
  systemInstruction: string,
): string {
  return [
    systemInstruction.trim(),
    "",
    "<tool_decision_stage>",
    "In this single pass, either emit one native tool/function call or return the final customer-facing JSON response.",
    "Use semantic understanding of the current customer request, recent chat history, chat context, and tool descriptions. Do not rely on keyword matching, language assumptions, or accent-specific rules.",
    "Call a tool only when one provided tool is necessary to satisfy the customer's request and all required arguments are known from the customer, recent chat history, or chat context.",
    "If no provided tool is necessary, if required arguments are missing or ambiguous, or if the answer is available from business context, return exactly one JSON object that follows the normal output contract.",
    "For missing or ambiguous required action details, do not call a tool; return a JSON clarification asking for the next needed detail.",
    "Do not write tool names as text. Use native tool/function calling when a tool is needed.",
    "</tool_decision_stage>",
  ].join("\n");
}

export function buildToolChoiceSystemInstruction(
  systemInstruction: string,
): string {
  const sanitizedSystemInstruction = systemInstruction
    .replace(/\n?<output_contract>[\s\S]*?<\/output_contract>/g, "")
    .replace(
      /^(\d+)\. Return one structured JSON object only\.$/gm,
      "$1. During tool selection, follow <tool_selection_stage> output rules instead of the JSON response contract.",
    )
    .trim();

  return [
    sanitizedSystemInstruction,
    "",
    "<tool_selection_stage>",
    "For this tool-selection stage only, suspend the normal JSON output contract.",
    "Your only job is to decide whether the current customer request, interpreted with recent chat history, needs one of the provided tools.",
    "If one provided tool is needed and all required arguments are known from the customer, chat history, or chat context, emit a native tool/function call for that tool.",
    "When checking required arguments, combine the current message with recent chat history and chat context. If a prior turn already contains the target, name, phone, email, or other required value, reuse it; return NO_TOOL_CALL only for details still missing or ambiguous.",
    "For booking, registration, follow-up contact, create, update, or cancel requests, the target item/service/course/order and required contact details count as required details even if a helper lookup has no formal arguments.",
    "Do not call a read/list/search helper merely to discover which item the customer wants; return NO_TOOL_CALL so the answer stage can ask for the missing target, unless the customer explicitly asked to see or check available options.",
    "Do not write JSON. Do not write integration_action_* as text. Do not answer the customer in this stage.",
    "If no provided tool should be called, or required arguments are missing, return exactly: NO_TOOL_CALL.",
    "</tool_selection_stage>",
  ].join("\n");
}

export async function invokeDecision(params: {
  systemInstruction: string;
  contents: AgentContent[];
  channel?: string | null;
  temperature?: number;
  timeoutMs?: number;
}): Promise<DecisionInvokeResult> {
  const messages = toLangChainMessages(params.contents, params.systemInstruction);
  const decisionSchema = getAiRoutingDecisionSchemaForChannel(params.channel);

  const { result, model } = await executeWithModelFallback<any>(
    async (tier, abortSignal, ctx) => {
      const llm = createChatModel({
        tier,
        temperature: params.temperature ?? 0.4,
        maxOutputTokens: ctx.defaultMaxOutputTokens ?? undefined,
      });
      // Each provider uses its optimal structured-output path. The Zod
      // schema is OpenAI strict-mode compliant (see
      // agentDecision.schema.ts), so OpenAI's default jsonSchema/strict
      // path works without a method override. Gemini and Anthropic pick
      // their respective defaults.
      const structured = llm.withStructuredOutput(decisionSchema, {
        name: "AiRoutingDecision",
        includeRaw: true,
      } as any);
      return structured.invoke(messages, { signal: abortSignal } as any);
    },
    "AgentGraph.callModel.decision",
    params.timeoutMs,
  );

  const rawMessage = result?.raw;
  const parsed =
    result && typeof result === "object" && "parsed" in result
      ? result.parsed
      : result;
  let schemaParsed;
  try {
    schemaParsed = decisionSchema.parse(parsed);
  } catch (parseError) {
    const rawText = rawMessage ? contentToText(rawMessage.content) : "";
    throw new ModelStructuredOutputError({
      rawText: rawText || JSON.stringify(parsed ?? {}),
      usage: readUsage(rawMessage),
      modelName: model,
      finishReason: readFinishReason(rawMessage),
      cause: parseError,
    });
  }
  const rawText = JSON.stringify(schemaParsed);
  const decision = repairAndParseAiResponse(rawText);

  return {
    decision,
    rawText,
    usage: readUsage(rawMessage),
    modelName: model,
    finishReason: readFinishReason(rawMessage),
  };
}

export async function invokeText(params: {
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  context?: string;
}): Promise<TextInvokeResult> {
  const messages = [new HumanMessage(params.prompt)];

  const { result: message, model } = await executeWithModelFallback<any>(
    (tier, abortSignal, ctx) => {
      const llm = createChatModel({
        tier,
        temperature: params.temperature ?? 0.4,
        maxOutputTokens:
          params.maxOutputTokens ?? ctx.defaultMaxOutputTokens ?? undefined,
      });
      return llm.invoke(messages, { signal: abortSignal } as any);
    },
    params.context || "AgentGraph.invokeText",
    params.timeoutMs,
  );

  return {
    text: contentToText(message.content),
    usage: readUsage(message),
    modelName: model,
    finishReason: readFinishReason(message),
  };
}

export async function invokeMediaUnderstanding(params: {
  prompt: string;
  mimeType: string;
  base64Data: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<TextInvokeResult> {
  const contents: AgentContent[] = [
    {
      role: "user",
      content: params.prompt,
      inlineData: {
        mimeType: params.mimeType,
        data: params.base64Data,
      },
    },
  ];
  const messages = toLangChainMessages(contents);

  const { result: message, model } = await executeWithModelFallback<any>(
    (tier, abortSignal) => {
      // Media understanding uses a small fixed ceiling (512) on purpose —
      // it's not a chat reply, so the chat default model's maxOutputTokens
      // does not apply here.
      const llm = createChatModel({
        tier,
        temperature: params.temperature ?? 0.1,
        maxOutputTokens: params.maxOutputTokens ?? 512,
      });
      return llm.invoke(messages, { signal: abortSignal } as any);
    },
    "AgentGraph.mediaUnderstanding",
    params.timeoutMs,
    "media_understanding",
  );

  return {
    text: contentToText(message.content),
    usage: readUsage(message),
    modelName: model,
    finishReason: readFinishReason(message),
  };
}

export async function invokeExternalToolRecoveryRoute(params: {
  prompt: string;
  timeoutMs?: number;
}) {
  const messages = [new HumanMessage(params.prompt)];

  const { result, model } = await executeWithModelFallback<any>(
    async (tier, abortSignal) => {
      // Classifier with a tight fixed ceiling — chat default's maxOutputTokens
      // does not apply.
      const llm = createChatModel({
        tier,
        temperature: 0,
        maxOutputTokens: 256,
      });
      const structured = llm.withStructuredOutput(externalToolRecoveryRouteSchema, {
        name: "ExternalToolRecoveryRoute",
        includeRaw: true,
      } as any);
      return structured.invoke(messages, { signal: abortSignal } as any);
    },
    "AgentGraph.externalToolRecoveryClassifier",
    params.timeoutMs,
  );

  const parsed = externalToolRecoveryRouteSchema.parse(result?.parsed ?? result);
  return {
    route: parsed.route,
    reasoning: parsed.reasoning,
    usage: readUsage(result?.raw),
    modelName: model,
    finishReason: readFinishReason(result?.raw),
  };
}
