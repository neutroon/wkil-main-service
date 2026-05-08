/**
 * Node: runTools
 *
 * Executes all tool calls requested by Gemini in the current turn.
 * Replaces the for-loop over functionCalls inside the while-loop.
 *
 * Production features:
 * - Zod validation on tool arguments before execution (prevents injection)
 * - Idempotency key per call (prevents double-execution on retry)
 * - Evidence tracking for the guardrail node downstream
 * - Appends function results back to contents for the next Gemini turn
 */
import { z } from "zod";
import { logger } from "@utils/logger";
import { pushLeadToCrm } from "@modules/integrations/crm/crm.service";
import { executeExternalQuery } from "@modules/integrations/external/externalData.service";
import { updateEvidenceFromEnvelope } from "@modules/ai-agent/core/aiEngine.utils";
import { generateSafeRecoveryReply } from "@modules/ai-agent/chat/aiRecoveryReply";
import { classifyExternalToolFailureRecovery } from "@modules/ai-agent/chat/externalToolRecoveryClassifier";
import type { AgentStateType } from "@modules/ai-agent/core/agentState";

// ── Zod Schemas for Tool Input Validation ─────────────────────────────────────

const CaptureLeadSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
}).passthrough(); // Crucial for production: allows custom fields from fieldMapping

const ExternalQuerySchema = z
  .object({
    q: z.string().optional(),
    query: z.string().optional(),
  })
  .passthrough(); // External APIs may have custom fields

// ── Node ──────────────────────────────────────────────────────────────────────

export async function runToolsNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const functionResponses: any[] = [];
  let updatedEvidence = { ...state.evidence };
  const leadPhone = state.customerPhone;
  let blockingDecision: AgentStateType["decision"] | null = null;

  for (const call of state.functionCalls) {
    if (!call.name) continue;

    // ── Idempotency key: unique per tool call instance ───────────────────
    // If the node retries (crash, timeout), the CRM sees the same key
    // and skips the duplicate insert.
    const idempotencyKey = `${call.id ?? call.name}_${state.businessProfileId}`;

    try {
      if (call.name === "capture_lead") {
        // ── Validate args with Zod ─────────────────────────────────────
        const parseResult = CaptureLeadSchema.safeParse(call.args);
        if (!parseResult.success) {
          logger.warn("ai.node.runTools.zod_rejection", {
            tool: call.name,
            errors: parseResult.error.flatten(),
          });
          const envelope = {
            success: false,
            verification: "failed" as const,
            actionType: "capture_lead",
            reason: "validation_failed: " + parseResult.error.message,
          };
          updatedEvidence = applyEvidence(
            updatedEvidence,
            envelope,
            "capture_lead",
          );
          functionResponses.push(buildFunctionResponse(call.name, envelope));
          continue;
        }

        const args = parseResult.data;
        const crmResult = await pushLeadToCrm(state.businessProfileId, {
          ...args,
          phone: args.phone || leadPhone,
          idempotencyKey,
          conversationId: state.conversationId,
        });

        const envelope = crmResult.success
          ? {
              success: true,
              verification: "verified" as const,
              actionType: "capture_lead",
              reason: "crm_saved",
              data: crmResult,
            }
          : {
              success: false,
              verification: "failed" as const,
              actionType: "capture_lead",
              reason: crmResult.error ?? "crm_rejected",
              data: crmResult,
            };

        if (!crmResult.success) {
          logger.warn("ai.node.runTools.crm_kickback", {
            error: crmResult.error,
          });
        }

        updatedEvidence = applyEvidence(
          updatedEvidence,
          envelope,
          "capture_lead",
        );
        functionResponses.push(buildFunctionResponse(call.name, envelope));
      } else if (call.name.startsWith("query_external_api_")) {
        const sourceId = parseInt(call.name.split("_").pop() || "0", 10);
        const actionType = `external_query_${sourceId}`;

        if (state.evidence.failedActions.includes(actionType)) {
          logger.warn("ai.node.runTools.external_query_retry_blocked", {
            sourceId,
            args: call.args,
          });
          const envelope = {
            success: false,
            verification: "failed" as const,
            actionType,
            reason: "duplicate_failed_lookup_blocked",
          };
          updatedEvidence = applyEvidence(updatedEvidence, envelope, actionType);
          functionResponses.push(buildFunctionResponse(call.name, envelope));
          blockingDecision = await buildExternalLookupFailedDecision(
            state,
            "The assistant tried to repeat a failed external lookup.",
            "duplicate_failed_lookup_blocked",
          );
          continue;
        }

        // ── Validate args with Zod ─────────────────────────────────────
        const parseResult = ExternalQuerySchema.safeParse(call.args);
        if (!parseResult.success) {
          logger.warn("ai.node.runTools.zod_rejection", {
            tool: call.name,
            errors: parseResult.error.flatten(),
          });
          const envelope = {
            success: false,
            verification: "failed" as const,
            actionType,
            reason: "validation_failed",
          };
          updatedEvidence = applyEvidence(
            updatedEvidence,
            envelope,
            actionType,
          );
          functionResponses.push(buildFunctionResponse(call.name, envelope));
          blockingDecision = await buildExternalLookupFailedDecision(
            state,
            "External lookup arguments failed validation.",
            "validation_failed",
          );
          continue;
        }

        logger.info("ai.node.runTools.external_query", {
          sourceId,
          args: parseResult.data,
        });
        const envelope = await executeExternalQuery(
          state.businessProfileId,
          sourceId,
          parseResult.data,
          {
            customerPhone: state.customerPhone,
            conversationId: state.conversationId,
            latestUserText: latestUserText(state.contents),
            historyText: userHistoryText(state.contents),
          },
        );
        updatedEvidence = applyEvidence(
          updatedEvidence,
          envelope,
          actionType,
        );
        functionResponses.push(buildFunctionResponse(call.name, envelope));
        if (envelope.verification === "failed") {
          blockingDecision = await buildExternalLookupFailedDecision(
            state,
            `External lookup failed: ${envelope.reason || "unknown"}.`,
            envelope.reason || "external_lookup_failed",
          );
        }
      }
    } catch (toolError: any) {
      logger.error("ai.node.runTools.unexpected_error", {
        tool: call.name,
        error: toolError.message,
      });
      const envelope = {
        success: false,
        verification: "failed" as const,
        actionType: call.name,
        reason: `tool_exception: ${toolError.message}`,
      };
      updatedEvidence = applyEvidence(updatedEvidence, envelope, call.name);
      functionResponses.push(buildFunctionResponse(call.name, envelope));
    }
  }

  return {
    // Append tool results as a user-role turn for the next Gemini call explicitly
    contents:
      functionResponses.length > 0
        ? [...state.contents, { role: "user", parts: functionResponses }]
        : state.contents,
    evidence: updatedEvidence,
    hadToolExecution: true,
    functionCalls: [], // Clear for next turn
    ...(blockingDecision ? { decision: blockingDecision } : {}),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFunctionResponse(name: string, response: unknown) {
  return { functionResponse: { name, response } };
}

function userHistoryText(contents: AgentStateType["contents"]): string {
  return contents
    .filter((turn) => turn.role === "user")
    .flatMap((turn) => turn.parts ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function latestUserText(contents: AgentStateType["contents"]): string {
  const latest = [...contents].reverse().find((turn) => turn.role === "user");
  return (latest?.parts ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

async function buildExternalLookupFailedDecision(
  state: AgentStateType,
  reasoning: string,
  failureReason: string,
): Promise<AgentStateType["decision"]> {
  const customerMessage = latestUserText(state.contents);
  const recoveryRoute = await classifyExternalToolFailureRecovery({
    customerMessage,
    failureReason,
  });
  const isNormalReply = recoveryRoute === "normal_reply";
  const fallback = isNormalReply
    ? state.policy.fallbackTemplates.smallTalkRecovery
    : state.policy.fallbackTemplates.failed;
  const recoveryReply = await generateSafeRecoveryReply({
    systemInstruction: state.systemInstruction,
    channel: state.channel,
    customerMessage,
    failureReason,
    safeFallback: fallback,
    allowHandoffLanguage: !isNormalReply,
  });

  return {
    action: isNormalReply ? "REPLY_AUTO" : "HANDOFF_TO_HUMAN",
    handoffCategory: isNormalReply ? null : "MISSING_KNOWLEDGE",
    reasoning: isNormalReply
      ? `${reasoning} Ignored non-essential external lookup failure.`
      : reasoning,
    content: recoveryReply,
    requiresGrounding: !isNormalReply,
    grounded: false,
    usedChunkTypes: [],
    missingInfo: isNormalReply
      ? null
      : "External live lookup could not be verified.",
    attachment: null,
  };
}

function applyEvidence(
  evidence: AgentStateType["evidence"],
  envelope: { verification?: string; actionType?: string },
  fallbackActionType: string,
): AgentStateType["evidence"] {
  const actionType = envelope.actionType || fallbackActionType;
  const updated = { ...evidence };

  switch (envelope.verification) {
    case "verified":
      updated.verifiedActions = [...evidence.verifiedActions, actionType];
      break;
    case "unverified":
      updated.unverifiedActions = [...evidence.unverifiedActions, actionType];
      break;
    case "failed":
      updated.failedActions = [...evidence.failedActions, actionType];
      break;
    default:
      updated.unknownActions = [...evidence.unknownActions, actionType];
      break;
  }
  return updated;
}
