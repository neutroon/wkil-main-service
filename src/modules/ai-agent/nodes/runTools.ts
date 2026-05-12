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
import { updateCustomerFromSavedDetails } from "@modules/business/customer/customer.service";
import { createBullMqJobId, enqueueIntegrationAction } from "@modules/meta/core/meta.queue";
import { getExternalDataSourceStatusMetadata } from "@modules/integrations/external/externalData.service";
import {
  createIntegrationActionRun,
  markIntegrationActionRunFailed,
} from "@modules/integrations/external/integrationActionRun.service";
import { generatePendingLookupStatusDecision } from "@modules/ai-agent/chat/pendingLookupStatus";
import { validateChatRequestedExternalAction } from "@modules/ai-agent/chat/externalToolEligibility";
import { classifyExternalToolFailureRecovery } from "@modules/ai-agent/chat/externalToolRecoveryClassifier";
import {
  buildAiRecoveryDecision,
  latestUserText,
} from "@modules/ai-agent/nodes/recoveryDecision";
import type { ExternalFailureBehavior } from "@modules/integrations/external/externalDataSource.constants";
import type { AgentStateType } from "@modules/ai-agent/core/agentState";

// ── Zod Schemas for Tool Input Validation ─────────────────────────────────────

const SaveCustomerDetailsSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
}).passthrough(); // Allows flexible customer fields such as interest, budget, or preferred time.

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
  let nextTools = state.tools;
  let blockingDecision: AgentStateType["decision"] | null = null;

  for (const call of state.functionCalls) {
    if (!call.name) continue;

    try {
      if (call.name === "save_customer_details") {
        // ── Validate args with Zod ─────────────────────────────────────
        const parseResult = SaveCustomerDetailsSchema.safeParse(call.args);
        if (!parseResult.success) {
          logger.warn("ai.node.runTools.zod_rejection", {
            tool: call.name,
            errors: parseResult.error.flatten(),
          });
          const envelope = {
            success: false,
            verification: "failed" as const,
            actionType: "save_customer_details",
            reason: "validation_failed: " + parseResult.error.message,
          };
          updatedEvidence = applyEvidence(
            updatedEvidence,
            envelope,
            "save_customer_details",
          );
          functionResponses.push(buildFunctionResponse(call.name, envelope));
          continue;
        }

        const args = parseResult.data;
        if (state.evidence.verifiedActions.includes("save_customer_details")) {
          nextTools = removeToolDeclaration(nextTools, "save_customer_details");
          logger.info("ai.node.runTools.customer_details_duplicate_ignored", {
            businessProfileId: state.businessProfileId,
            conversationId: state.conversationId,
          });
          functionResponses.push(
            buildFunctionResponse(call.name, {
              success: true,
              verification: "not_applicable",
              actionType: "save_customer_details",
              reason: "customer_details_already_saved_this_turn",
              data: { saved: false },
            }),
          );
          continue;
        }

        const customer = await updateCustomerFromSavedDetails({
          businessProfileId: state.businessProfileId,
          conversationId: state.conversationId,
          details: args,
        });

        const envelope = {
          success: true,
          verification: "verified" as const,
          actionType: "save_customer_details",
          reason: "customer_details_saved",
          data: {
            customerId: customer.id,
          },
        };

        updatedEvidence = applyEvidence(
          updatedEvidence,
          envelope,
          "save_customer_details",
        );
        nextTools = removeToolDeclaration(nextTools, "save_customer_details");
        functionResponses.push(buildFunctionResponse(call.name, envelope));
      } else if (call.name.startsWith("integration_action_")) {
        const sourceId = parseInt(call.name.split("_").pop() || "0", 10);
        const actionType = `integration_action_${sourceId}`;
        const latestMessage = latestUserText(state);

        if (!isToolDeclarationExposed(state.tools, call.name)) {
          const envelope = {
            success: false,
            verification: "failed" as const,
            actionType,
            reason: "tool_not_exposed_for_turn",
            data: null,
          };
          updatedEvidence = applyEvidence(
            updatedEvidence,
            envelope,
            actionType,
          );
          functionResponses.push(buildFunctionResponse(call.name, envelope));
          blockingDecision = await buildExternalLookupFailedDecision(
            state,
            "The assistant tried to call an integration action that was not exposed for this turn.",
            "tool_not_exposed_for_turn",
            sourceId,
          );
          continue;
        }

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
            sourceId,
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
            sourceId,
          );
          continue;
        }

        logger.info("ai.node.runTools.external_query", {
          sourceId,
          args: parseResult.data,
        });

        if (!state.conversationId) {
          const envelope = {
            success: false,
            verification: "failed" as const,
            actionType,
            reason: "missing_conversation_context",
            data: null,
          };
          updatedEvidence = applyEvidence(
            updatedEvidence,
            envelope,
            actionType,
          );
          functionResponses.push(buildFunctionResponse(call.name, envelope));
          blockingDecision = await buildExternalLookupFailedDecision(
            state,
            "Integration action could not be queued without conversation context.",
            "missing_conversation_context",
            sourceId,
          );
          continue;
        }

        const sourceMetadata = await getExternalDataSourceStatusMetadata(
          state.businessProfileId,
          sourceId,
        );
        if (!sourceMetadata) {
          const envelope = {
            success: false,
            verification: "failed" as const,
            actionType,
            reason: "source_missing_or_inactive",
            data: null,
          };
          updatedEvidence = applyEvidence(
            updatedEvidence,
            envelope,
            actionType,
          );
          functionResponses.push(buildFunctionResponse(call.name, envelope));
          blockingDecision = await buildExternalLookupFailedDecision(
            state,
            "Integration action source was missing or inactive.",
            "source_missing_or_inactive",
            sourceId,
          );
          continue;
        }

        const validation = await validateChatRequestedExternalAction({
          source: sourceMetadata,
          latestUserMessage: latestMessage,
          args: parseResult.data,
          historyText: userHistoryText(state.contents),
          customerPhone: state.customerPhone,
          conversationId: state.conversationId,
        });
        if (!validation.shouldQueue) {
          logger.warn("ai.node.runTools.external_query_blocked_by_policy", {
            sourceId,
            latestMessage: latestMessage.slice(0, 120),
            reason: validation.reasoning,
            businessProfileId: state.businessProfileId,
            conversationId: state.conversationId,
          });
          functionResponses.push(
            buildFunctionResponse(call.name, {
              success: true,
              verification: "not_applicable",
              actionType,
              reason: "action_policy_rejected",
              data: {
                queued: false,
                policyReason: validation.reasoning,
              },
            }),
          );
          nextTools = removeToolDeclaration(nextTools, call.name);
          continue;
        }
        const jobId = createBullMqJobId(
          "integration-action",
          "CHAT_REQUESTED",
          state.conversationId,
          call.id || call.name,
        );
        const actionRun = await createIntegrationActionRun({
          businessProfileId: state.businessProfileId,
          sourceId,
          conversationId: state.conversationId,
          trigger: "CHAT_REQUESTED",
          actionType,
          toolName: call.name,
          jobId,
          requestPayload: parseResult.data,
        });

        try {
          await enqueueIntegrationAction(
            {
              businessProfileId: state.businessProfileId,
              trigger: "CHAT_REQUESTED",
              conversationId: state.conversationId,
              sourceId,
              actionRunId: actionRun.id,
              toolName: call.name,
              args: parseResult.data,
              customerPhone: state.customerPhone,
              latestUserText: latestMessage,
              historyText: userHistoryText(state.contents),
            },
            { jobId },
          );
        } catch (error: any) {
          await markIntegrationActionRunFailed({
            id: actionRun.id,
            reason: error?.message || "queue_failed",
          });
          throw error;
        }

        const envelope = {
          success: true,
          verification: "verified" as const,
          actionType,
          reason: "integration_action_queued",
          data: {
            queued: true,
            sourceId,
            actionRunId: actionRun.id,
          },
        };
        updatedEvidence = applyEvidence(
          updatedEvidence,
          envelope,
          actionType,
        );
        functionResponses.push(buildFunctionResponse(call.name, envelope));
        blockingDecision = await generatePendingLookupStatusDecision({
          businessName: state.businessName || "the business",
          voice: state.businessVoice,
          tone: state.businessTone,
          channel: state.channel,
          latestUserText: latestMessage,
          recentTurns: recentTextTurns(state.contents, 3),
          source: sourceMetadata,
        }) ?? buildSilentExternalLookupQueuedDecision();
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
      if (call.name.startsWith("integration_action_")) {
        const sourceId = parseInt(call.name.split("_").pop() || "0", 10);
        blockingDecision = await buildExternalLookupFailedDecision(
          state,
          `Integration action failed: ${toolError.message}.`,
          "integration_action_failed",
          sourceId,
        );
      }
    }
  }

  return {
    // Append tool results as a user-role turn for the next Gemini call explicitly
    contents:
      functionResponses.length > 0
        ? [...state.contents, { role: "user", parts: functionResponses }]
        : state.contents,
    tools: nextTools,
    evidence: updatedEvidence,
    hadToolExecution: true,
    functionCalls: [], // Clear for next turn
    ...(blockingDecision ? { decision: blockingDecision } : {}),
  };
}

function buildSilentExternalLookupQueuedDecision(): AgentStateType["decision"] {
  return {
    action: "REPLY_AUTO",
    handoffCategory: null,
    reasoning:
      "Chat-requested action was queued, but pending-status generation timed out or returned no safe text.",
    content: "",
    publicContent: "",
    privateContent: "",
    requiresGrounding: false,
    grounded: true,
    usedChunkTypes: [],
    missingInfo: null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFunctionResponse(name: string, response: unknown) {
  return { functionResponse: { name, response } };
}

function removeToolDeclaration(
  tools: AgentStateType["tools"],
  functionName: string,
): AgentStateType["tools"] {
  if (!tools?.length) return tools;

  const filtered = tools
    .map((tool: any) => {
      const functionDeclarations = tool.functionDeclarations?.filter(
        (declaration: any) => declaration?.name !== functionName,
      );
      return { ...tool, functionDeclarations };
    })
    .filter((tool: any) => (tool.functionDeclarations?.length ?? 0) > 0);

  return filtered.length > 0 ? filtered : undefined;
}

function isToolDeclarationExposed(
  tools: AgentStateType["tools"],
  functionName: string,
): boolean {
  return Boolean(
    tools?.some((tool: any) =>
      tool.functionDeclarations?.some(
        (declaration: any) => declaration?.name === functionName,
      ),
    ),
  );
}

function userHistoryText(contents: AgentStateType["contents"]): string {
  return contents
    .filter((turn) => turn.role === "user")
    .flatMap((turn) => turn.parts ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function recentTextTurns(
  contents: AgentStateType["contents"],
  limit: number,
): Array<{ role: "user" | "model"; text: string }> {
  return contents
    .filter((turn) => turn.role === "user" || turn.role === "model")
    .map((turn) => ({
      role: turn.role,
      text: (turn.parts ?? [])
        .filter((part) => typeof part.text === "string")
        .map((part) => part.text)
        .join(" ")
        .trim(),
    }))
    .filter((turn) => turn.text.length > 0)
    .slice(-limit);
}

async function buildExternalLookupFailedDecision(
  state: AgentStateType,
  reasoning: string,
  failureReason: string,
  sourceId?: number,
): Promise<AgentStateType["decision"]> {
  const customerMessage = latestUserText(state);
  const recoveryRoute = await resolveExternalFailureRoute({
    state,
    customerMessage,
    failureReason,
    sourceId,
  });
  const isNormalReply = recoveryRoute === "normal_reply";
  const fallback = isNormalReply
    ? state.policy.fallbackTemplates.smallTalkRecovery
    : state.policy.fallbackTemplates.failed;
  return buildAiRecoveryDecision(state, {
    action: isNormalReply ? "REPLY_AUTO" : "HANDOFF_TO_HUMAN",
    handoffCategory: isNormalReply ? null : "MISSING_KNOWLEDGE",
    reasoning: isNormalReply
      ? `${reasoning} Ignored non-essential external lookup failure.`
      : reasoning,
    failureReason,
    emergencyFallback: fallback,
    allowHandoffLanguage: !isNormalReply,
    requiresGrounding: !isNormalReply,
    missingInfo: isNormalReply
      ? null
      : "External action result could not be verified.",
  });
}

async function resolveExternalFailureRoute(params: {
  state: AgentStateType;
  customerMessage: string;
  failureReason: string;
  sourceId?: number;
}): Promise<"normal_reply" | "handoff"> {
  const { state, customerMessage, failureReason, sourceId } = params;
  if (sourceId) {
    const failureBehavior =
      (state.externalSourceFailureBehaviors?.[sourceId] || "AUTO") as ExternalFailureBehavior;

    switch (failureBehavior) {
      case "HANDOFF_ON_FAILURE":
        return "handoff";
      case "ANSWER_WITH_CONTEXT_ON_FAILURE":
      case "SILENT_ON_FAILURE":
        return "normal_reply";
      case "AUTO":
      default:
        break;
    }
  }

  return classifyExternalToolFailureRecovery({
    customerMessage,
    failureReason,
  });
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
