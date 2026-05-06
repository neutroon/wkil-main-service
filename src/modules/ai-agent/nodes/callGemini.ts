/**
 * Node: callGemini
 *
 * Calls the Gemini API via the existing executeWithFallback() cascade.
 * Replaces the try/catch block inside the while-loop.
 *
 * Production features:
 * - 25-second per-call timeout via Promise.race
 * - Automatic 3-tier model fallback (PRIMARY → RESERVE → STABLE)
 * - Accumulates token usage into sessionStats for billing
 * - Routes to HANDOFF_TO_HUMAN on timeout or unrecoverable error
 */
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import {
  genAI,
  executeWithFallback,
  MESSENGER_SAFETY_SETTINGS,
  aiRoutingSchema,
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

  try {
    const raceResult = await Promise.race([
      executeWithFallback<any>(
        async (currentModel) => {
          const r = await genAI.models.generateContentStream({
            model: currentModel,
            contents: windowedContents as any,
            config: {
              systemInstruction: state.systemInstruction,
              temperature: 0.4,
              maxOutputTokens: 2048,
              safetySettings: MESSENGER_SAFETY_SETTINGS,
              tools: state.tools as any,
              responseMimeType: "application/json",
              responseSchema: aiRoutingSchema,
            },
          });

          // ── Streaming loop ───────────────────────────────────────────
          let fullText = "";
          let finalUsage: any = null;
          let allParts: any[] = [];

          for await (const chunk of r) {
            // Safely get text without triggering the SDK's internal warning
            const parts = chunk.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.text) {
                fullText += part.text;
                await dispatchCustomEvent("ai_token", { token: part.text });
              }
              allParts.push(part);
            }

            if (chunk.usageMetadata) finalUsage = chunk.usageMetadata;
          }

          // ── Validation: No parts = Failure ──────────────────────────
          if (allParts.length === 0) {
            throw new Error("EMPTY_CANDIDATES");
          }

          // Reconstruct a response-like object for the rest of the node
          return {
            usageMetadata: finalUsage,
            fullText,
            parts: allParts,
            firstCandidate: allParts.length > 0 ? { content: { parts: allParts } } : null,
            functionCalls: allParts
              ?.filter((p: any) => p.functionCall)
              ?.map((p: any) => p.functionCall) || [],
          };
        },
        "AgentGraph.callGemini",
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("GEMINI_TIMEOUT")),
          GEMINI_TIMEOUT_MS,
        ),
      ),
    ]);

    responseResult = raceResult.result;
    usedModel = raceResult.model;
  } catch (error: any) {
    const isTimeout = error.message === "GEMINI_TIMEOUT";
    const isEmpty = error.message === "EMPTY_CANDIDATES";
    
    logger.error("ai.node.callGemini.failed", {
      isTimeout,
      isEmpty,
      error: error.message,
      businessProfileId: state.businessProfileId,
      channel: state.channel,
    });

    // Route to a terminal HANDOFF decision — downstream nodes handle delivery
    return {
      decision: {
        action: "HANDOFF_TO_HUMAN",
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
  }

  // ── Parse Gemini response structure ────────────────────────────────────────
  const functionCalls = (responseResult.functionCalls || []).map((fc: any) => ({
    id:   fc.id || `${fc.name}_${Date.now()}`,
    name: fc.name,
    args: fc.args,
  }));

  // ── Accumulate token usage (across multi-turn loops) ────────────────────
  const meta = responseResult?.usageMetadata;
  const hasGrounding = !!(responseResult.firstCandidate as any)?.groundingMetadata?.searchEntryPoint;
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

  const finalStateUpdate = {
    // Append the model's response turn to history explicitly
    // USE the actual parts returned by Gemini to maintain the full chain of thought
    contents: [
      ...state.contents,
      { 
        role: "model" as const, 
        parts: responseResult.parts 
      }
    ],
    functionCalls,
    turnCount:     state.turnCount + 1,
    sessionStats:  updatedStats,
  };

  // ── Real-time Differential Billing ──────────────────────────────────────────
  // We bill the DELTA since the last time this turn (or previous turns) recorded usage.
  // This ensures that even if the graph interrupts for Manual Approval, we've billed for the thinking time.
  const deltaPrompt = updatedStats.promptTokens - updatedStats.lastBilledPromptTokens;
  const deltaCompletion = updatedStats.completionTokens - updatedStats.lastBilledCompletionTokens;
  const deltaGrounding = updatedStats.groundingCalls - updatedStats.lastBilledGrounding;

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

  return finalStateUpdate;
}




