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
} from "../../../config/gemini";
import { logger } from "../../../utils/logger";
import type { AgentStateType } from "../agentState";
import { windowContents, estimateSystemTokens } from "../contextWindow";

const GEMINI_TIMEOUT_MS = 35_000;

export async function callGeminiNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const systemTokens = estimateSystemTokens(state.systemInstruction);
  const windowedContents = windowContents(state.contents, systemTokens);

  let responseResult: any;
  let usedModel = state.sessionStats.modelName;

  try {
    const raceResult = await Promise.race([
      executeWithFallback(
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
          let finalCandidates: any[] = [];

          for await (const chunk of r) {
            const text = chunk.text;
            if (text) {
              fullText += text;
              // Dispatch token to any listeners (e.g. the web widget)
              await dispatchCustomEvent("ai_token", { token: text });
            }
            if (chunk.usageMetadata) finalUsage = chunk.usageMetadata;
            if (chunk.candidates) finalCandidates = chunk.candidates;
          }

          // ── Validation: No candidates = Failure ──────────────────────────
          // If Gemini returns a successful response but no candidates (e.g. safety block),
          // we throw so executeWithFallback can scale to the next model tier.
          if (!finalCandidates || finalCandidates.length === 0) {
            throw new Error("EMPTY_CANDIDATES");
          }

          // Reconstruct a response-like object for the rest of the node
          return {
            result: {
              candidates: finalCandidates,
              usageMetadata: finalUsage,
              // Add a helper for the functionCalls extractor
              functionCalls: finalCandidates?.[0]?.content?.parts
                ?.filter((p: any) => p.functionCall)
                ?.map((p: any) => p.functionCall) || [],
            },
            model: currentModel,
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

    const { result, model } = raceResult as { result: any; model: string };
    responseResult = result;
    usedModel = model;
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
          ? `Gemini timed out (${GEMINI_TIMEOUT_MS}ms)`
          : isEmpty 
            ? "Gemini returned no candidates (potential safety block across all models)."
            : `Gemini unrecoverable failure: ${error.message}`,
        content: "",
      },
      sessionStats: { ...state.sessionStats, modelName: usedModel },
    };
  }

  // ── Parse Gemini response structure ────────────────────────────────────────
  // candidate is guaranteed to exist here because we throw if candidates.length === 0 inside executeWithFallback
  const candidate = responseResult.candidates[0];

  const responseParts = candidate.content?.parts || [];
  const functionCalls = (responseResult.functionCalls || []).map((fc: any) => ({
    id:   fc.id || `${fc.name}_${Date.now()}`,
    name: fc.name,
    args: fc.args,
  }));

  // ── Accumulate token usage (across multi-turn loops) ────────────────────
  const meta = responseResult?.usageMetadata;
  const hasGrounding = !!candidate.groundingMetadata?.searchEntryPoint;
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

  return {
    // Append the model's response turn to history
    contents:      [{ role: "model", parts: responseParts }],
    functionCalls,
    turnCount:     state.turnCount + 1,
    sessionStats:  updatedStats,
  };
}
