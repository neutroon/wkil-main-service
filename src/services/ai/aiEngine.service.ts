import { Tool } from "@google/genai";
import { logger } from "../../utils/logger";
import generateContent, { genAI, MESSENGER_SAFETY_SETTINGS, aiRoutingSchema, executeWithFallback } from "../../config/gemini";
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
  return (
    value === "verified" || value === "unverified" || value === "failed"
  );
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

export interface AiRoutingDecision {
  action: "REPLY_AUTO" | "HANDOFF_TO_HUMAN" | "RESOLVE_CONVERSATION";
  handoffCategory?: string | null;
  reasoning: string;
  content?: string | null;
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
  const policy = resolveTruthfulnessPolicy(params.policy);

  // Prepare User Part (Text + Optional Media)
  const userParts: any[] = [{ text: params.customerMessage }];

  // If we have media, fetch its data for Gemini Multimodal
  if (params.mediaInfo && (params.mediaInfo.type === "image" || params.mediaInfo.type === "audio" || params.mediaInfo.type === "voice")) {
    try {
      // 1. Resolve Token
      let accessToken = "";
      if (params.channel === "whatsapp") {
          const account = await prisma.whatsAppAccount.findFirst({
             where: { businessProfileId: params.businessProfileId, isActive: true },
             select: { accessToken: true }
          });
          if (account) {
            const { decryptFacebookSecret } = await import("../../utils/tokenCrypto");
            accessToken = decryptFacebookSecret(account.accessToken);
          }
      } else if (params.channel === "messenger") {
          const page = await prisma.facebookPage.findFirst({
             where: { businessProfileId: params.businessProfileId, isActive: true },
             select: { pageAccessToken: true }
          });
          if (page) {
            const { decryptFacebookSecret } = await import("../../utils/tokenCrypto");
            accessToken = decryptFacebookSecret(page.pageAccessToken);
          }
      }

      // 2. Resolve URL and Fetch Data
      if (accessToken && params.mediaInfo.id) {
        const { getMetaMediaUrl } = await import("../meta/metaMedia.service");
        const url = await getMetaMediaUrl(params.mediaInfo.id, accessToken);
        const response = await fetch(url);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const mimeType = response.headers.get("content-type") || (params.mediaInfo.type === "image" ? "image/jpeg" : "audio/ogg");
          userParts.push({
            inlineData: {
              data: buffer.toString("base64"),
              mimeType
            }
          });
          logger.info("ai.multimodal.media_attached", { type: params.mediaInfo.type, mimeType });
        }
      }
    } catch (e) {
      logger.warn("ai.multimodal.attach_failed", { error: String(e) });
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
    modelName: "gemini-2.5-flash" // Default
  };

  while (turnCount < MAX_TURNS) {
    turnCount++;
    let responseResult;
    try {
      // Use executeWithFallback to benefit from intelligent failover (2.5 -> 2.0 -> Stable)
      const { result, model } = await executeWithFallback(async (currentModel) => {
        return await genAI.models.generateContent({
          model: currentModel,
          contents,
          config: {
            systemInstruction: params.systemInstruction,
            temperature: 0.35,
            maxOutputTokens: 512,
            safetySettings: MESSENGER_SAFETY_SETTINGS,
            tools: params.tools,
            responseMimeType: "application/json",
            responseSchema: aiRoutingSchema,
          },
        });
      }, "AIEngineChatLoop");

      responseResult = result;
      sessionStats.modelName = model; // Track which model actually succeeded for billing
    } catch (error: any) {
      logger.error("AI Engine Loop: Unexpected Error", { error: error.message });
      return {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "SYSTEM_ERROR",
        reasoning: `Unexpected AI Failure: ${error.message}`,
        content: "" // Silent to customer
      };
    }

    const response = responseResult;
    const candidate = (response as any).candidates?.[0];
    if (!candidate) throw new Error("No candidate from Gemini");

    const responseParts = candidate.content?.parts || [];
    let responseText = responseParts.filter((p: any) => p.text).map((p: any) => p.text).join("").trim();

    // Sum usage metadata
    const meta = (response as any).usageMetadata;
    const grounding = candidate.groundingMetadata?.searchEntryPoint;
    if (meta) {
      sessionStats.promptTokens += (meta.promptTokenCount || 0);
      sessionStats.completionTokens += (meta.candidatesTokenCount || 0);
      if (grounding) sessionStats.groundingCalls += 1;
    }

    const functionCalls = response.functionCalls || [];
    if (functionCalls.length === 0) {
      if (!responseText) throw new Error("No reply text and no function call generated");
      
      let decision: AiRoutingDecision;
      try {
        decision = JSON.parse(responseText);
      } catch (err) {
        logger.error("Failed to parse JSON from AI response", { responseText });
        decision = {
          action: "REPLY_AUTO",
          reasoning: "Failed to parse JSON structure",
          content: responseText
        };
      }

      if (hadToolExecutionInTurn) {
        const blocked = evaluateGuardrailsForReply(evidence, decision.content || "", policy);
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
        businessProfileId: params.businessProfileId,
        modelName: sessionStats.modelName,
        promptTokens: sessionStats.promptTokens,
        completionTokens: sessionStats.completionTokens,
        groundingCalls: sessionStats.groundingCalls
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
            }
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
            }
          });
        }
      } else if (call.name.startsWith("query_external_api_")) {
        const sourceId = parseInt(call.name.split("_").pop() || "0", 10);
        logger.info("ai.executing_external_tool", { sourceId, args });
        const envelope = await executeExternalQuery(sourceId, args);
        updateEvidenceFromEnvelope(evidence, envelope, `external_query_${sourceId}`);
        
        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: envelope,
          }
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

/**
 * Builds a highly structured, production-grade system instruction 
 * extracting all brand identity, products, and FAQs from the Business Profile.
 */
function generateSystemInstruction(profile: any, channel: string): string {
  const faqs = profile.faqs && profile.faqs.length > 0 
    ? profile.faqs.map((f: any) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n") 
    : "No specific FAQs available.";
  
  return `
You are the official AI representative for "${profile.name}".

--- BUSINESS IDENTITY ---
${profile.identity || "A professional business."}

--- TARGET AUDIENCE ---
${profile.targetAudience || "General customers."}

--- TONE & VOICE ---
Voice: ${profile.voice || "Professional"}
Tone: ${profile.tone || "Friendly"}
(Always communicate using this precise tone and voice, ensuring natural flow in the specified language.)

--- PRODUCTS & SERVICES ---
${profile.productsServices?.length ? profile.productsServices.join(", ") : "Various products and services."}

--- CONTACT & HOURS ---
Phone: ${profile.phoneNumbers?.join(", ") || "Not provided"}
Hours: ${profile.workingHours || "Not provided"}
Address: ${profile.address || "Not provided"}

--- CORE POLICIES ---
${profile.corePolicies || "Standard business policies apply."}

--- KNOWLEDGE BASE (FAQs) ---
${faqs}

--- RULES & PROTOCOLS (CRITICAL) ---
1. You MUST respond exclusively in JSON matching the defined routing schema.
2. If the user asks a question covered by the Knowledge Base or context, answer confidently via REPLY_AUTO.
3. If the user asks for something completely outside your knowledge, or is angry/complaining, or explicitly asks for a human, you MUST use HANDOFF_TO_HUMAN.
4. Channel: ${channel}. Keep formatting suitable for this channel (e.g., WhatsApp supports *bold*, web supports standard markdown).
5. Do not make promises that are not part of the core policies.
6. Provide brief but accurate reasoning for your decision in the "reasoning" field.

Format your entire output exactly as a JSON object matching the aiRoutingDecision schema. Do not output markdown code blocks for the JSON.
`.trim();
}

/**
 * The unified Coordinator function that prepares the high-end context
 * and executes the AI engine loop.
 */
export async function computeBusinessChatReply(params: {
  businessProfile: any;
  messageText: string;
  historyTurns: { role: "user" | "model"; text?: string; parts?: any[] }[];
  channel: "messenger" | "whatsapp" | "webchat" | "web";
  customerPhone?: string;
  tools?: Tool[];
}): Promise<AiRoutingDecision> {
  const { businessProfile, messageText, historyTurns, channel, customerPhone, tools } = params;

  // Guarantee we have full profile loaded including FAQs
  const fullProfile = await prisma.businessProfile.findUnique({
    where: { id: businessProfile.id },
    include: {
      faqs: true,
      externalDataSources: { where: { isActive: true } },
      crmIntegrations: { where: { isActive: true }, take: 1 }
    }
  });

  if (!fullProfile) {
    logger.error("computeBusinessChatReply: Business Profile not found", { id: businessProfile.id });
    throw new Error("Business Profile not found");
  }

  const systemInstruction = generateSystemInstruction(fullProfile, channel);

  return runAIEngineLoop({
    systemInstruction,
    historyTurns,
    customerMessage: messageText,
    tools: tools || [],
    businessProfileId: businessProfile.id,
    customerPhone,
    channel: (channel === "web" ? "webchat" : channel) as any,
  });
}
