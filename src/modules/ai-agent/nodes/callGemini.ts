/**
 * Node: callGemini
 *
 * Calls the Gemini API via the existing executeWithFallback() cascade.
 * Replaces the try/catch block inside the while-loop.
 *
 * Production features:
 * - Abortable 60-second total call budget
 * - Automatic 3-tier model fallback (PRIMARY → RESERVE → STABLE)
 * - Accumulates token usage into sessionStats for billing
 * - Routes provider outages to review instead of inventing unsupported facts
 */
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import {
  genAI,
  executeWithFallback,
  isRetryableGeminiError,
  MESSENGER_SAFETY_SETTINGS,
  buildAiRoutingSchema,
} from "../gemini";
import { windowContents, estimateSystemTokens } from "../core/contextWindow";
import { enqueueAiUsageRecord } from "@modules/billing/billing.queue";
import { recordAiUsage } from "@modules/billing/billing.service";
import { logger } from "@utils/logger";
import type { AgentStateType } from "../core/agentState";
import { buildAiRecoveryDecision } from "./recoveryDecision";
import { repairStructuredDecisionOutput } from "./structuredOutputRepair";

const GEMINI_TIMEOUT_MS = 360_000;
const GEMINI_MAX_OUTPUT_TOKENS = 4096;
const BLOCKED_FINISH_REASONS = new Set(["SAFETY", "RECITATION"]);

export function normalizeGeminiFinishReason(
  reason?: string | null,
): string | null {
  return typeof reason === "string" && reason.trim()
    ? reason.trim().toUpperCase()
    : null;
}

export function shouldRejectGeminiOutput(params: {
  finishReason?: string | null;
  fullText: string;
  functionCallCount: number;
}): { reject: boolean; reason?: string } {
  const finishReason = normalizeGeminiFinishReason(params.finishReason);
  if (!finishReason) return { reject: false };
  if (BLOCKED_FINISH_REASONS.has(finishReason)) {
    return { reject: true, reason: finishReason };
  }

  const looksLikePartialStructuredReply =
    params.functionCallCount === 0 &&
    params.fullText.trim().startsWith("{") &&
    !params.fullText.trim().endsWith("}");

  if (finishReason === "MAX_TOKENS" && looksLikePartialStructuredReply) {
    return { reject: true, reason: "MAX_TOKENS" };
  }

  return { reject: false };
}

function buildUpdatedStats(
  state: AgentStateType,
  responseResult: any,
  usedModel: string,
): typeof state.sessionStats {
  const meta = responseResult?.usageMetadata;
  const hasGrounding = !!(responseResult?.candidate as any)?.groundingMetadata
    ?.searchEntryPoint;

  return {
    ...state.sessionStats,
    modelName: usedModel,
    promptTokens:
      state.sessionStats.promptTokens +
      (meta?.promptTokenCount ?? meta?.promptTokens ?? 0),
    completionTokens:
      state.sessionStats.completionTokens +
      (meta?.candidatesTokenCount ?? meta?.completionTokens ?? 0),
    groundingCalls: state.sessionStats.groundingCalls + (hasGrounding ? 1 : 0),
  };
}

export async function callGeminiNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const systemTokens = estimateSystemTokens(state.systemInstruction);
  const windowedContents = windowContents(state.contents, systemTokens);

  let responseResult: any;
  let usedModel = state.sessionStats.modelName;
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort("GEMINI_TIMEOUT"),
    GEMINI_TIMEOUT_MS,
  );

  try {
    const raceResult = await executeWithFallback<any>(
      async (currentModel) => {
        const r = await genAI.models.generateContentStream({
          model: currentModel,
          contents: windowedContents as any,
          config: {
            abortSignal: abortController.signal,
            httpOptions: { timeout: GEMINI_TIMEOUT_MS },
            systemInstruction: state.systemInstruction,
            temperature: 0.4,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            safetySettings: MESSENGER_SAFETY_SETTINGS,
            tools: state.tools as any,
            responseMimeType: "application/json",
            responseSchema: buildAiRoutingSchema(state.channel),
          },
        });

        // ── Stream Aggregator ──────────────────────────────────────────
        let fullText = "";
        let accumulatedParts: any[] = [];
        let usageMetadata: any = null;
        let groundingMetadata: any = null;
        let finishReason: string | null = null;

        for await (const chunk of r) {
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) {
            finishReason = String(candidate.finishReason);
          }

          // 1. Process Parts (Text & Function Calls)
          const parts = candidate?.content?.parts || [];
          for (const part of parts) {
            if (part.text) {
              fullText += part.text;
              await dispatchCustomEvent("ai_token", { token: part.text });
            }
            accumulatedParts.push(part);
          }

          // 2. Capture Usage & Safety
          if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
          if (chunk.candidates?.[0]?.groundingMetadata) {
            groundingMetadata = chunk.candidates[0].groundingMetadata;
          }
        }

        // ── Post-Stream Validation ───────────────────────────────────
        const functionCalls = accumulatedParts
          .filter((p: any) => p.functionCall)
          .map((p: any) => p.functionCall);
        const outputRejection = shouldRejectGeminiOutput({
          finishReason,
          fullText,
          functionCallCount: functionCalls.length,
        });
        if (outputRejection.reject) {
          logger.warn("ai.node.callGemini.provider_output_rejected", {
            finishReason: outputRejection.reason,
            businessProfileId: state.businessProfileId,
            channel: state.channel,
            textLength: fullText.length,
            functionCallCount: functionCalls.length,
          });

          return {
            fullText,
            usageMetadata,
            parts: [],
            candidate: {
              content: { parts: [] },
              groundingMetadata,
            },
            functionCalls: [],
            providerRejectedReason: outputRejection.reason,
          };
        }

        if (accumulatedParts.length === 0) {
          throw new Error("EMPTY_RESPONSE");
        }

        return {
          fullText,
          usageMetadata,
          parts: accumulatedParts,
          // Reconstruct a candidate-like structure for downstream usage nodes
          candidate: {
            content: { parts: accumulatedParts },
            groundingMetadata,
          },
          functionCalls,
        };
      },
      "AgentGraph.callGemini",
      undefined,
      undefined,
      abortController.signal,
    );

    responseResult = raceResult.result;
    usedModel = raceResult.model;
  } catch (error: any) {
    const isTimeout =
      error.message === "GEMINI_TIMEOUT" ||
      abortController.signal.aborted ||
      error?.name === "AbortError";
    const isEmpty = error.message === "EMPTY_RESPONSE";
    const isTransientProviderFailure =
      isTimeout || isRetryableGeminiError(error);

    logger.error("ai.node.callGemini.failed", {
      isTimeout,
      isEmpty,
      isTransientProviderFailure,
      error: error.message,
      businessProfileId: state.businessProfileId,
      channel: state.channel,
    });

    // Route to a terminal HANDOFF decision — downstream nodes handle delivery
    return {
      decision: {
        action: "HANDOFF_TO_HUMAN",
        replyType: "HANDOFF",
        handoffCategory: isTimeout ? "SYSTEM_TIMEOUT" : "SYSTEM_ERROR",
        reasoning: isTimeout
          ? `[v4.3] Gemini timed out (${GEMINI_TIMEOUT_MS}ms)`
          : isEmpty
            ? "[v4.3] Gemini returned no candidates (potential safety block across all models)."
            : `[v4.3] Gemini unrecoverable failure: ${error.message}`,
        content: "",
      },
      sessionStats: { ...state.sessionStats, modelName: usedModel },
    };
  } finally {
    clearTimeout(timeout);
  }

  const updatedStats = buildUpdatedStats(state, responseResult, usedModel);
  if (responseResult.providerRejectedReason) {
    const invalidOutput =
      typeof responseResult.fullText === "string"
        ? responseResult.fullText.trim()
        : "";

    if (
      responseResult.providerRejectedReason === "MAX_TOKENS" &&
      invalidOutput.startsWith("{")
    ) {
      const repaired = await repairStructuredDecisionOutput({
        state: { ...state, sessionStats: updatedStats },
        invalidOutput,
        parseError: new Error("Gemini returned partial JSON before MAX_TOKENS."),
      });

      if (repaired) {
        return repaired;
      }
    }

    return {
      decision: await buildAiRecoveryDecision(state, {
        action: "REPLY_AUTO",
        reasoning: `Gemini output was rejected before parsing because the provider finished with ${responseResult.providerRejectedReason}.`,
        failureReason:
          responseResult.providerRejectedReason === "MAX_TOKENS"
            ? "incomplete_model_reply_max_tokens"
            : `gemini_output_${String(responseResult.providerRejectedReason).toLowerCase()}`,
        emergencyFallback: state.policy.fallbackTemplates.unverified,
        allowHandoffLanguage: false,
        requiresGrounding: false,
        missingInfo: null,
      }),
      sessionStats: updatedStats,
    };
  }

  // ── Parse Gemini response structure ────────────────────────────────────────
  const functionCalls = (responseResult.functionCalls || []).map((fc: any) => ({
    id: fc.id || `${fc.name}_${Date.now()}`,
    name: fc.name,
    args: fc.args,
  }));

  // ── Accumulate token usage (across multi-turn loops) ────────────────────
  logger.info("ai.node.callGemini.success", {
    model: usedModel,
    turnCount: state.turnCount + 1,
    functionCalls: functionCalls.map((f: any) => f.name),
    businessProfileId: state.businessProfileId,
  });

  // ── Real-time Differential Billing ──────────────────────────────────────────
  // We bill the DELTA since the last time this turn (or previous turns) recorded usage.
  // This ensures that even if the graph interrupts for Manual Approval, we've billed for the thinking time.
  const deltaPrompt = Math.max(
    0,
    updatedStats.promptTokens - updatedStats.lastBilledPromptTokens,
  );
  const deltaCompletion = Math.max(
    0,
    updatedStats.completionTokens - updatedStats.lastBilledCompletionTokens,
  );
  const deltaGrounding = Math.max(
    0,
    updatedStats.groundingCalls - updatedStats.lastBilledGrounding,
  );

  if (deltaPrompt > 0 || deltaCompletion > 0 || deltaGrounding > 0) {
    const usagePayload = {
      userId: state.userId,
      businessProfileId: state.businessProfileId,
      modelName: usedModel,
      promptTokens: deltaPrompt,
      completionTokens: deltaCompletion,
      groundingCalls: deltaGrounding,
      operation: `chat_${state.channel || "direct"}`,
    };

    try {
      await enqueueAiUsageRecord(usagePayload, {
        jobId: [
          "ai-usage",
          state.agentTurnId || "turn",
          state.turnCount + 1,
          usedModel,
          deltaPrompt,
          deltaCompletion,
          deltaGrounding,
        ].join("-"),
      });

      // Synchronize state: mark these tokens as billed
      updatedStats.lastBilledPromptTokens = updatedStats.promptTokens;
      updatedStats.lastBilledCompletionTokens = updatedStats.completionTokens;
      updatedStats.lastBilledGrounding = updatedStats.groundingCalls;
    } catch (err: any) {
      logger.error("ai.node.callGemini.billing_enqueue_failed", {
        error: err.message,
        businessProfileId: state.businessProfileId,
      });
      try {
        await recordAiUsage(usagePayload);
        updatedStats.lastBilledPromptTokens = updatedStats.promptTokens;
        updatedStats.lastBilledCompletionTokens = updatedStats.completionTokens;
        updatedStats.lastBilledGrounding = updatedStats.groundingCalls;
      } catch (fallbackErr: any) {
        logger.error("ai.node.callGemini.billing_failed", {
          error: fallbackErr.message,
          businessProfileId: state.businessProfileId,
        });
        // We don't update lastBilled counters here, so the next turn (or recordUsage node) will retry.
      }
    }
  }

  return {
    // Append the model's response turn to history explicitly.
    // Use the actual parts returned by Gemini to preserve tool-call history.
    contents: [
      ...state.contents,
      {
        role: "model" as const,
        parts: responseResult.parts,
      },
    ],
    functionCalls,
    turnCount: state.turnCount + 1,
    sessionStats: updatedStats,
  };
}
