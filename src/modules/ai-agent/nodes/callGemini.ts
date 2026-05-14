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
import { recordAiUsage } from "@modules/billing/billing.service";
import { logger } from "@utils/logger";
import type { AgentStateType } from "../core/agentState";

const GEMINI_TIMEOUT_MS = 60_000;

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
            maxOutputTokens: 2048,
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

        for await (const chunk of r) {
          // 1. Process Parts (Text & Function Calls)
          const parts = chunk.candidates?.[0]?.content?.parts || [];
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
          functionCalls: accumulatedParts
            .filter((p: any) => p.functionCall)
            .map((p: any) => p.functionCall),
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
    const isTransientProviderFailure = isTimeout || isRetryableGeminiError(error);
    
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

  // ── Parse Gemini response structure ────────────────────────────────────────
  const functionCalls = (responseResult.functionCalls || []).map((fc: any) => ({
    id:   fc.id || `${fc.name}_${Date.now()}`,
    name: fc.name,
    args: fc.args,
  }));

  // ── Accumulate token usage (across multi-turn loops) ────────────────────
  const meta = responseResult?.usageMetadata;
  const hasGrounding = !!(responseResult.candidate as any)?.groundingMetadata?.searchEntryPoint;
  const updatedStats: typeof state.sessionStats = {
    ...state.sessionStats,
    modelName: usedModel,
    promptTokens:
      state.sessionStats.promptTokens +
      (meta?.promptTokenCount ?? meta?.promptTokens ?? 0),
    completionTokens:
      state.sessionStats.completionTokens +
      (meta?.candidatesTokenCount ?? meta?.completionTokens ?? 0),
    groundingCalls:
      state.sessionStats.groundingCalls + (hasGrounding ? 1 : 0),
  };

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
    try {
      await recordAiUsage({
        userId: state.userId,
        businessProfileId: state.businessProfileId,
        modelName: usedModel,
        promptTokens: deltaPrompt,
        completionTokens: deltaCompletion,
        groundingCalls: deltaGrounding,
        operation: `chat_${state.channel || "direct"}`,
      });

      // Synchronize state: mark these tokens as billed
      updatedStats.lastBilledPromptTokens = updatedStats.promptTokens;
      updatedStats.lastBilledCompletionTokens = updatedStats.completionTokens;
      updatedStats.lastBilledGrounding = updatedStats.groundingCalls;
    } catch (err: any) {
      logger.error("ai.node.callGemini.billing_failed", {
        error: err.message,
        businessProfileId: state.businessProfileId
      });
      // We don't update lastBilled counters here, so the next turn (or recordUsage node) will retry.
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




