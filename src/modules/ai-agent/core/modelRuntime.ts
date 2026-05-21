import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { env } from "@config/env";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";
import {
  aiRoutingDecisionSchema,
  externalToolRecoveryRouteSchema,
} from "./agentDecision.schema";
import type {
  AgentContent,
  AgentToolDefinition,
  SessionStats,
  ToolCall,
} from "./agentState";
import type { AiRoutingDecision } from "./aiEngine.utils";
import { repairAndParseAiResponse } from "./aiEngine.utils";

const MODEL_TIMEOUT_MS = 60_000;
const MODEL_TIERS = [
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash",
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

async function executeWithModelFallback<T>(
  operation: (model: string, abortSignal: AbortSignal) => Promise<T>,
  context: string,
  timeoutMs = MODEL_TIMEOUT_MS,
): Promise<{ result: T; model: string }> {
  let lastError: any;

  for (let tierIndex = 0; tierIndex < MODEL_TIERS.length; tierIndex++) {
    const model = MODEL_TIERS[tierIndex];
    let attempt = 0;

    while (attempt < 2) {
      const abortController = new AbortController();
      try {
        const result = await withTimeout(
          operation(model, abortController.signal),
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
            delayMs: Math.round(delay),
            error: parseProviderErrorMessage(error),
          });
          await waitWithAbort(delay, abortController.signal);
          continue;
        }

        if (tierIndex < MODEL_TIERS.length - 1) {
          logger.warn("ai.model_runtime.fallback_model", {
            context,
            model,
            nextModel: MODEL_TIERS[tierIndex + 1],
            retryable,
            error: parseProviderErrorMessage(error),
          });
          break;
        }

        const message = parseProviderErrorMessage(error);
        logger.error("ai.model_runtime.final_failure", {
          context,
          model,
          error: message,
        });
        throw new AppError(message, 502);
      }
    }
  }

  throw lastError;
}

function createChatModel(params: {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}) {
  return new ChatGoogleGenerativeAI({
    model: params.model,
    apiKey: env.GEMINI_API_KEY,
    temperature: params.temperature ?? 0.4,
    maxOutputTokens: params.maxOutputTokens ?? 2048,
  });
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

export async function invokeToolChoice(params: {
  systemInstruction: string;
  contents: AgentContent[];
  tools: AgentToolDefinition[];
  temperature?: number;
  timeoutMs?: number;
}): Promise<ToolChoiceResult> {
  const messages = toLangChainMessages(params.contents, params.systemInstruction);

  const { result: message, model } = await executeWithModelFallback<any>(
    (currentModel, abortSignal) => {
      const llm = createChatModel({
        model: currentModel,
        temperature: params.temperature ?? 0.4,
      }).bindTools(params.tools as any);
      return llm.invoke(messages, { signal: abortSignal } as any);
    },
    "AgentGraph.callModel.toolChoice",
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

export async function invokeDecision(params: {
  systemInstruction: string;
  contents: AgentContent[];
  temperature?: number;
  timeoutMs?: number;
}): Promise<DecisionInvokeResult> {
  const messages = toLangChainMessages(params.contents, params.systemInstruction);

  const { result, model } = await executeWithModelFallback<any>(
    async (currentModel, abortSignal) => {
      const llm = createChatModel({
        model: currentModel,
        temperature: params.temperature ?? 0.4,
      });
      const structured = llm.withStructuredOutput(aiRoutingDecisionSchema, {
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
    schemaParsed = aiRoutingDecisionSchema.parse(parsed);
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
    (currentModel, abortSignal) => {
      const llm = createChatModel({
        model: currentModel,
        temperature: params.temperature ?? 0.4,
        maxOutputTokens: params.maxOutputTokens,
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
    (currentModel, abortSignal) => {
      const llm = createChatModel({
        model: currentModel,
        temperature: params.temperature ?? 0.1,
        maxOutputTokens: params.maxOutputTokens ?? 512,
      });
      return llm.invoke(messages, { signal: abortSignal } as any);
    },
    "AgentGraph.mediaUnderstanding",
    params.timeoutMs,
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
    async (currentModel, abortSignal) => {
      const llm = createChatModel({
        model: currentModel,
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
