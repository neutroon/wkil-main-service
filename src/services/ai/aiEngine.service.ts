import { Tool } from "@google/genai";
import { logger } from "../../utils/logger";
import { genAI, MESSENGER_SAFETY_SETTINGS } from "../../config/gemini";
import { pushLeadToCrm } from "../crm/crm.service";
import { executeExternalQuery } from "../external/externalData.service";

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

export async function runAIEngineLoop(params: {
  systemInstruction: string;
  historyTurns: { role: "user" | "model"; text?: string; parts?: any[] }[];
  customerMessage: string;
  tools?: Tool[];
  businessProfileId: number;
  customerPhone?: string; // fallback
  channel?: "messenger" | "whatsapp" | "web";
  policy?: Partial<AiTruthfulnessPolicy>;
}): Promise<string> {
  const policy = resolveTruthfulnessPolicy(params.policy);
  const contents = [
    ...params.historyTurns.map((t) => ({
      role: t.role,
      parts: t.parts ? t.parts : [{ text: t.text }],
    })),
    {
      role: "user" as const,
      parts: [{ text: params.customerMessage }],
    },
  ];

  let turnCount = 0;
  const MAX_TURNS = 3;
  const evidence = makeEmptyEvidence();
  let hadToolExecutionInTurn = false;

  while (turnCount < MAX_TURNS) {
    turnCount++;
    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: params.systemInstruction,
        temperature: 0.35,
        maxOutputTokens: 512,
        safetySettings: MESSENGER_SAFETY_SETTINGS,
        tools: params.tools,
      },
    });

    const candidate = (response as any).candidates?.[0];
    if (!candidate) throw new Error("No candidate from Gemini");

    const responseParts = candidate.content?.parts || [];
    
    // Safely extract text parts
    let responseText = responseParts
      .filter((p: any) => p.text)
      .map((p: any) => p.text)
      .join("")
      .trim();

    const functionCalls = response.functionCalls || [];

    // If there's no function call, we are done
    if (functionCalls.length === 0) {
      if (!responseText) throw new Error("No reply text and no function call generated");
      if (hadToolExecutionInTurn) {
        const blocked = evaluateGuardrailsForReply(evidence, responseText, policy);
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
          return blocked.safeReply;
        }
      }
      return responseText;
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
