import { Tool } from "@google/genai";
import { logger } from "../../utils/logger";
import {
  generateContent,
  genAI,
  MESSENGER_SAFETY_SETTINGS,
  aiRoutingSchema,
  executeWithFallback,
  buildCaptureLeadTool,
} from "../../config/gemini";
import { pushLeadToCrm } from "../crm/crm.service";
import { executeExternalQuery } from "../external/externalData.service";
import { recordAiUsage } from "../billing.service";
import prisma from "../../config/prisma";

type VerificationStatus = "verified" | "unverified" | "failed";

type ToolResultEnvelope = {
  success: boolean;
  verification?: VerificationStatus;
  actionType?: string;
  reason?: string;
  data?: unknown;
};

export type AiTruthfulnessPolicy = {
  strictBlockOnUnverified: boolean;
  blockPromiseLanguage: boolean;
  fallbackTemplates: {
    unverified: string;
    failed: string;
    unsupportedPromise: string;
  };
};

export const DEFAULT_AI_TRUTHFULNESS_POLICY: AiTruthfulnessPolicy = {
  strictBlockOnUnverified: true,
  blockPromiseLanguage: true,
  fallbackTemplates: {
    unverified:
      "I cannot confirm this action yet from the latest system data. Please share the exact required identifier so I can verify it.",
    failed:
      "I could not complete verification due to a system lookup issue. Please recheck the details and send them exactly as provided.",
    unsupportedPromise:
      "I can only confirm actions that were completed and verified in this chat flow. I cannot promise additional actions that were not executed.",
  },
};

type EvidenceState = {
  verifiedActions: string[];
  unverifiedActions: string[];
  failedActions: string[];
  unknownActions: string[];
};

export type AiEvidenceState = EvidenceState;

function makeEmptyEvidence(): EvidenceState {
  return {
    verifiedActions: [],
    unverifiedActions: [],
    failedActions: [],
    unknownActions: [],
  };
}

function resolveTruthfulnessPolicy(
  override?: Partial<AiTruthfulnessPolicy>,
): AiTruthfulnessPolicy {
  if (!override) return DEFAULT_AI_TRUTHFULNESS_POLICY;
  return {
    ...DEFAULT_AI_TRUTHFULNESS_POLICY,
    ...override,
    fallbackTemplates: {
      ...DEFAULT_AI_TRUTHFULNESS_POLICY.fallbackTemplates,
      ...(override.fallbackTemplates || {}),
    },
  };
}

function isVerificationStatus(
  value: unknown,
): value is "verified" | "unverified" | "failed" {
  return value === "verified" || value === "unverified" || value === "failed";
}

function updateEvidenceFromEnvelope(
  evidence: EvidenceState,
  envelope: ToolResultEnvelope,
  fallbackActionType: string,
): void {
  const actionType = envelope.actionType || fallbackActionType;
  if (!isVerificationStatus(envelope.verification)) {
    evidence.unknownActions.push(actionType);
    return;
  }
  if (envelope.verification === "verified") {
    evidence.verifiedActions.push(actionType);
  } else if (envelope.verification === "unverified") {
    evidence.unverifiedActions.push(actionType);
  } else {
    evidence.failedActions.push(actionType);
  }
}

function hasUnsupportedPromiseLanguage(text: string): boolean {
  return /(?:we will call you|we'll call you|someone will contact you|i have escalated|ticket created|تم\s*التواصل|سنتواصل|سوف\s*نتواصل|تم\s*رفع\s*طلب)/i.test(
    text,
  );
}

export function evaluateGuardrailsForReply(
  evidence: EvidenceState,
  text: string,
  policy: AiTruthfulnessPolicy,
): { blocked: false } | { blocked: true; ruleId: string; safeReply: string } {
  if (evidence.failedActions.length > 0) {
    return {
      blocked: true,
      ruleId: "TRUTH_FAILED_ACTION",
      safeReply: policy.fallbackTemplates.failed,
    };
  }
  if (policy.strictBlockOnUnverified && evidence.unknownActions.length > 0) {
    return {
      blocked: true,
      ruleId: "TRUTH_UNKNOWN_ACTION",
      safeReply: policy.fallbackTemplates.unverified,
    };
  }
  if (policy.strictBlockOnUnverified && evidence.unverifiedActions.length > 0) {
    return {
      blocked: true,
      ruleId: "TRUTH_UNVERIFIED_ACTION",
      safeReply: policy.fallbackTemplates.unverified,
    };
  }
  if (policy.blockPromiseLanguage && hasUnsupportedPromiseLanguage(text)) {
    return {
      blocked: true,
      ruleId: "PROMISE_UNSUPPORTED",
      safeReply: policy.fallbackTemplates.unsupportedPromise,
    };
  }
  return { blocked: false };
}

/**
 * PRODUCTION-GRADE: Resilient JSON parser for LLM outputs.
 * Handles truncated strings by closing quotes/brackets and falling back to regex extraction.
 */
/**
 * PRODUCTION-GRADE: Sanitizes LLM output to prevent 'ghost loops' and 'stuttering'.
 * Removes common invisible unicode characters and heals word-level repetitions.
 */
export function sanitizeAiText(text: string): string {
  if (!text) return "";

  // 1. Remove invisible junk (variation selectors, zero-width spaces, etc.)
  let sanitized = text
    .replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // 2. HEAL: Word-level Repetition (Stuttering)
  // Catch phrases or words repeated 3+ times (e.g., "Hello Hello Hello")
  const phrasePattern = /(\b.+?\b)\1{3,}/gi;
  if (phrasePattern.test(sanitized)) {
    logger.warn("ai.engine.stutter_detected", { original: sanitized.substring(0, 100) });
    // Keep the first execution of the pattern, discard the rest
    sanitized = sanitized.replace(phrasePattern, "$1");
  }

  // 3. HEAL: Hard-Truncate extreme length (Backup guard)
  // Most social replies shouldn't exceed 2000 chars unless explicitly long-form
  if (sanitized.length > 5000) {
    logger.warn("ai.engine.excessive_length_truncated", { length: sanitized.length });
    sanitized = sanitized.substring(0, 2000) + "...";
  }

  return sanitized;
}

function repairAndParseAiResponse(text: string): AiRoutingDecision {
  let cleaned = text.trim();
  let decision: any = null;

  // 1. Basic JSON Parse
  try {
    decision = JSON.parse(cleaned);
  } catch (e) {
    // 2. Attempt Repair (Mid-stream truncation)
    let repaired = cleaned;
    const doubleQuoteCount = (repaired.match(/"/g) || []).length;
    if (doubleQuoteCount % 2 !== 0) repaired += '"';

    const stack: string[] = [];
    for (const char of repaired) {
      if (char === "{") stack.push("}");
      if (char === "[") stack.push("]");
      if (char === "}" || char === "]") {
        if (stack[stack.length - 1] === char) stack.pop();
      }
    }
    while (stack.length > 0) repaired += stack.pop();

    try {
      decision = JSON.parse(repaired);
    } catch (e2) {
      // 3. Regex Fallback (Final stand)
      const action = cleaned.match(/"action"\s*:\s*"([^"]+)"/)?.[1];
      const reasoning = cleaned.match(/"reasoning"\s*:\s*"([^"]+)"/)?.[1] || "";
      const content = cleaned.match(/"content"\s*:\s*"([^"]+)"/)?.[1] || "";
      const publicContent = cleaned.match(/"publicContent"\s*:\s*"([^"]+)"/)?.[1] || "";
      const privateContent = cleaned.match(/"privateContent"\s*:\s*"([^"]+)"/)?.[1] || "";
      const intent = cleaned.match(/"intent"\s*:\s*"([^"]+)"/)?.[1];

      decision = {
        action: action || "REPLY_AUTO",
        intent: intent || "NONE",
        reasoning,
        content,
        publicContent,
        privateContent,
      };
    }
  }

  // 4. Normalization & Sanitization
  const finalDecision: AiRoutingDecision = {
    action: decision.action || "REPLY_AUTO",
    intent: decision.intent || "NONE",
    reasoning: decision.reasoning || "",
    content: sanitizeAiText(decision.content || ""),
    publicContent: sanitizeAiText(decision.publicContent || ""),
    privateContent: sanitizeAiText(decision.privateContent || ""),
    attachment: decision.attachment,
  };

  // 5. ELITE TIER: Sales Delivery Repairer (Global Fail-Safe)
  // If the intent is SALES_DM but the AI forgot the private text, we MUST repair it.
  if (finalDecision.intent === "SALES_DM" && !finalDecision.privateContent) {
    if (finalDecision.publicContent || finalDecision.content) {
      logger.warn("ai.engine.delivery_gap_repaired", { 
        intent: finalDecision.intent,
        reasoning: finalDecision.reasoning 
      });
      // Append a CTA to ensure divergence
      const base = finalDecision.publicContent || finalDecision.content;
      finalDecision.privateContent = `${base}\n\nCould you please share your requirements or phone number so our team can provide the specific details you need?`;
    } else {
      // Hard fallback if everything is empty but intent is sales
      finalDecision.privateContent = "Hello! I am sending you the details you requested right now. How can I help you proceed?";
    }
  }

  return finalDecision;
}

function hasExcessiveRepetition(text: string): boolean {
  if (!text || text.length < 50) return false;
  const sanitized = sanitizeAiText(text);
  
  // 1. Character-level loops (aaaaa)
  const charPattern = /(.)\1{9,}/;
  if (charPattern.test(sanitized)) return true;

  // 2. Word-level loops (word word word word)
  const wordPattern = /(\b.+?\b)\s+\1\s+\1\s+\1/gi;
  if (wordPattern.test(sanitized)) return true;

  // 3. Block-level loops (A block of text repeating twice)
  // We check for large chunks (50+ chars) that repeat
  if (sanitized.length > 200) {
    const half = Math.floor(sanitized.length / 2);
    for (let len = 50; len <= half; len++) {
      for (let i = 0; i <= sanitized.length - len * 2; i++) {
        const chunk = sanitized.substring(i, i + len);
        const rest = sanitized.substring(i + len);
        if (rest.includes(chunk)) {
          // If a 50+ char block repeats, it's a hallucination/loop
          return true;
        }
      }
    }
  }

  return false;
}

export interface AiRoutingDecision {
  action: "REPLY_AUTO" | "HANDOFF_TO_HUMAN" | "RESOLVE_CONVERSATION";
  intent?: "SALES_DM" | "GREET_ONLY" | "IGNORE" | "NONE";
  handoffCategory?: string | null;
  reasoning: string;
  content?: string | null;
  publicContent?: string | null;
  privateContent?: string | null;
  attachment?: { assetName: string; caption?: string | null } | null;
}

export async function runAIEngineLoop(params: {
  systemInstruction: string;
  historyTurns: { role: "user" | "model"; text?: string; parts?: any[] }[];
  customerMessage: string;
  tools?: Tool[];
  businessProfileId: number;
  customerPhone?: string; // fallback
  channel?: "messenger" | "whatsapp" | "web";
  policy?: Partial<AiTruthfulnessPolicy>;
  mediaInfo?: { id: string; type: string; url?: string };
}): Promise<AiRoutingDecision> {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: params.businessProfileId },
    select: { userId: true },
  });

  if (!profile) {
    throw new Error("Business profile not found");
  }

  const userId = profile.userId;
  const policy = resolveTruthfulnessPolicy(params.policy);

  // Prepare User Part (Text + Optional Media)
  let userText = params.customerMessage;

  // PRODUCTION GUARD: If the text is empty but media is present,
  // explicitly tell Gemini to acknowledge the file. This prevents generic repetitions.
  if (!userText.trim() && params.mediaInfo) {
    const mediaType =
      params.mediaInfo.type === "voice" ? "voice note" : params.mediaInfo.type;
    userText = `[Customer sent a ${mediaType}. Please analyze it and respond based on your business identity and context.]`;
  }

  const userParts: any[] = [{ text: userText }];

  // If we have media, fetch its data for Gemini Multimodal
  if (
    params.mediaInfo &&
    (params.mediaInfo.type === "image" ||
      params.mediaInfo.type === "audio" ||
      params.mediaInfo.type === "voice")
  ) {
    try {
      // 1. Resolve Token
      let accessToken = "";
      if (params.channel === "whatsapp") {
        const account = await prisma.whatsAppAccount.findFirst({
          where: {
            businessProfileId: params.businessProfileId,
            isActive: true,
          },
          select: { accessToken: true },
        });
        if (account) {
          const { decryptFacebookSecret } =
            await import("../../utils/tokenCrypto");
          accessToken = decryptFacebookSecret(account.accessToken);
        }
      } else if (params.channel === "messenger") {
        const page = await prisma.facebookPage.findFirst({
          where: {
            businessProfileId: params.businessProfileId,
            isActive: true,
          },
          select: { pageAccessToken: true },
        });
        if (page) {
          const { decryptFacebookSecret } =
            await import("../../utils/tokenCrypto");
          accessToken = decryptFacebookSecret(page.pageAccessToken);
        }
      }

      // 2. Resolve URL and Fetch Data
      if (accessToken && (params.mediaInfo.id || params.mediaInfo.url)) {
        let url = params.mediaInfo.url;

        if (!url && params.mediaInfo.id) {
          const { getMetaMediaUrl } = await import("../meta/metaMedia.service");
          url = await getMetaMediaUrl(
            params.mediaInfo.id,
            accessToken,
            params.channel as any,
          );
        }

        if (!url) throw new Error("Could not resolve media URL");

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          let mimeType =
            response.headers.get("content-type") ||
            (params.mediaInfo.type === "image" ? "image/jpeg" : "audio/ogg");

          // PRODUCTION GUARD: Messenger often sends voice/audio in .mp4 containers.
          // Gemini fails if it sees 'video/mp4' but there are no video frames.
          if (
            (params.mediaInfo.type === "audio" ||
              params.mediaInfo.type === "voice") &&
            mimeType === "video/mp4"
          ) {
            mimeType = "audio/mp4";
          }
          userParts.push({
            inlineData: {
              data: buffer.toString("base64"),
              mimeType,
            },
          });
          logger.info("ai.multimodal.media_attached", {
            type: params.mediaInfo.type,
            mimeType,
          });
        } else {
          // PRODUCTION FAIL-SAFE:
          // If we can't fetch the media, we don't let the AI guess.
          // We trigger a silent handoff to the sales team.
          logger.error("ai.multimodal.fetch_failed", {
            status: response.status,
            type: params.mediaInfo.type,
            mediaId: params.mediaInfo.id,
          });

          return {
            action: "HANDOFF_TO_HUMAN",
            handoffCategory: "SYSTEM_ERROR",
            reasoning: `Could not fetch ${params.mediaInfo.type} from Meta (HTTP ${response.status}). Requiring human intervention.`,
            content:
              "[MEDIA_PROCESSING_ERROR]: The AI could not retrieve this file. Please handle this message manually.",
          };
        }
      }
    } catch (e) {
      logger.error("ai.multimodal.attach_unhandled_error", {
        error: String(e),
      });
      return {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "SYSTEM_ERROR",
        reasoning: `Unhandled error during media attachment: ${String(e)}`,
        content: "[SYSTEM_CRITICAL_FAILURE]: Human intervention required.",
      };
    }
  }

  const contents = [
    ...params.historyTurns.map((t) => ({
      role: t.role,
      parts: t.parts ? t.parts : [{ text: t.text }],
    })),
    {
      role: "user" as const,
      parts: userParts,
    },
  ];

  let turnCount = 0;
  const MAX_TURNS = 3;
  const evidence = makeEmptyEvidence();
  let hadToolExecutionInTurn = false;

  // Track usage across multiple turns
  const sessionStats = {
    promptTokens: 0,
    completionTokens: 0,
    groundingCalls: 0,
    modelName: "gemini-3.1-flash", // Default
  };

  while (turnCount < MAX_TURNS) {
    turnCount++;
    let responseResult;
    try {
      // Use executeWithFallback to benefit from intelligent failover (2.5 -> 2.0 -> Stable)
      const { result, model } = await executeWithFallback(
        async (currentModel) => {
          return await genAI.models.generateContent({
            model: currentModel,
            contents,
            config: {
              systemInstruction: params.systemInstruction,
              temperature: 0.4,
              maxOutputTokens: 2048,
              safetySettings: MESSENGER_SAFETY_SETTINGS,
              tools: params.tools,
              responseMimeType: "application/json",
              responseSchema: aiRoutingSchema,
            },
          });
        },
        "AIEngineChatLoop",
      );

      responseResult = result;
      sessionStats.modelName = model; // Track which model actually succeeded for billing
    } catch (error: any) {
      logger.error("AI Engine Loop: Unexpected Error", {
        error: error.message,
      });
      return {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "SYSTEM_ERROR",
        reasoning: `Unexpected AI Failure: ${error.message}`,
        content: "", // Silent to customer
      };
    }

    const response = responseResult;
    const candidate = (response as any).candidates?.[0];
    if (!candidate) throw new Error("No candidate from Gemini");

    const responseParts = candidate.content?.parts || [];
    let responseText = responseParts
      .filter((p: any) => p.text)
      .map((p: any) => p.text)
      .join("")
      .trim();

    // Sum usage metadata
    const meta = (response as any).usageMetadata;
    const grounding = candidate.groundingMetadata?.searchEntryPoint;
    if (meta) {
      sessionStats.promptTokens += meta.promptTokenCount || 0;
      sessionStats.completionTokens += meta.candidatesTokenCount || 0;
      if (grounding) sessionStats.groundingCalls += 1;
    }

    const functionCalls = response.functionCalls || [];
    if (functionCalls.length === 0) {
      if (!responseText)
        throw new Error("No reply text and no function call generated");

      // FAIL-SAFE: If the AI output is insane (e.g. 4000+ chars), it's a hallucination.
      if (responseText.length > 4000) {
        logger.warn("ai.engine.hallucination_detected", { length: responseText.length });
        return {
          action: "HANDOFF_TO_HUMAN",
          handoffCategory: "SYSTEM_ERROR",
          reasoning: "AI hallucination detected (excessive output length). Safe-failing to human.",
          content: ""
        };
      }

      let decision: AiRoutingDecision;
      try {
        // High-resilience parsing
        decision = repairAndParseAiResponse(responseText);

        // Content Repetition Guardrail (Anti-Loop)
        if (hasExcessiveRepetition(decision.content || "") || hasExcessiveRepetition(decision.publicContent || "")) {
          logger.warn("ai.engine.loop_detected", { responseText });
          decision = {
            action: "HANDOFF_TO_HUMAN",
            handoffCategory: "SYSTEM_ERROR",
            reasoning: "AI loop detected (excessive repetition). Safe-failing to human.",
            content: ""
          };
        }
      } catch (err) {
        logger.error("ai.engine.parsing_failed", {
          responseText,
          error: (err as any).message,
          inputLength: params.customerMessage?.length || 0,
          hasMedia: !!params.mediaInfo,
        });

        // PRODUCTION FAIL-SAFE:
        // 1. Send NOTHING to the customer (silent failure)
        // 2. Alert the Sales Team via SYSTEM_ERROR handoff
        decision = {
          action: "HANDOFF_TO_HUMAN",
          handoffCategory: "SYSTEM_ERROR",
          reasoning:
            "AI Response parsing failed (potential mid-stream truncation). Failing silently to customer.",
          content: "",
        };
      }
      if (hadToolExecutionInTurn) {
        const blocked = evaluateGuardrailsForReply(
          evidence,
          decision.content || "",
          policy,
        );
        if (blocked.blocked) {
          logger.warn("ai.guardrail.blocked_response", {
            businessProfileId: params.businessProfileId,
            channel: params.channel || "unknown",
            ruleId: blocked.ruleId,
            actionTypes: {
              verified: evidence.verifiedActions,
              unverified: evidence.unverifiedActions,
              failed: evidence.failedActions,
              unknown: evidence.unknownActions,
            },
          });
          decision.action = "REPLY_AUTO";
          decision.reasoning = "Guardrail Triggered: " + blocked.ruleId;
          decision.content = blocked.safeReply;
        }
      }

      // Log usage via new service
      recordAiUsage({
        userId,
        businessProfileId: params.businessProfileId,
        modelName: sessionStats.modelName,
        promptTokens: sessionStats.promptTokens,
        completionTokens: sessionStats.completionTokens,
        groundingCalls: sessionStats.groundingCalls,
        operation: `chat_${params.channel || "direct"}`,
      }).catch(console.error);

      return decision;
    }

    // Add the model's turn (with its function calling request) to the contents history
    contents.push({
      role: "model",
      parts: responseParts,
    });

    // Execute all requested functions
    const functionResponses: any[] = [];
    for (const call of functionCalls) {
      if (!call.name) continue; // Skip empty function calls to fix linter warning
      hadToolExecutionInTurn = true;

      const args = call.args as any;

      if (call.name === "capture_lead") {
        const crmResult = await pushLeadToCrm(params.businessProfileId, {
          ...args,
          phone: args.phone || params.customerPhone,
        });

        if (crmResult.success) {
          const envelope: ToolResultEnvelope = {
            success: true,
            verification: "verified",
            actionType: "capture_lead",
            reason: "crm_saved",
            data: crmResult,
          };
          updateEvidenceFromEnvelope(evidence, envelope, "capture_lead");
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: envelope,
            },
          });
        } else {
          logger.warn("ai.crm_validation_kickback", { error: crmResult.error });
          const envelope: ToolResultEnvelope = {
            success: false,
            verification: "failed",
            actionType: "capture_lead",
            reason: crmResult.error || "crm_validation_rejected",
            data: crmResult,
          };
          updateEvidenceFromEnvelope(evidence, envelope, "capture_lead");
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: envelope,
            },
          });
        }
      } else if (call.name.startsWith("query_external_api_")) {
        const sourceId = parseInt(call.name.split("_").pop() || "0", 10);
        logger.info("ai.executing_external_tool", { sourceId, args });
        const envelope = await executeExternalQuery(sourceId, args);
        updateEvidenceFromEnvelope(
          evidence,
          envelope,
          `external_query_${sourceId}`,
        );

        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: envelope,
          },
        });
      }
    }

    // Append function results back to the user context so Gemini sees the data
    if (functionResponses.length > 0) {
      contents.push({
        role: "user",
        parts: functionResponses,
      });
    }
  }

  throw new Error("Exceeded max AI tool turns without Final Answer");
}

