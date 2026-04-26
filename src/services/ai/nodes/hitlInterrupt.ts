/**
 * Node: hitlInterrupt
 *
 * Human-in-the-Loop (HITL) checkpoint.
 *
 * When responseMode === "MANUAL", this node pauses graph execution using
 * LangGraph's interrupt() function. The graph state (including the AI's
 * draft reply) is persisted to PostgreSQL via the checkpointer.
 *
 * The business owner reviews the draft in the PagesPilot dashboard and
 * either approves, edits, or rejects it. The caller then resumes the graph
 * with Command({ resume: approvedContent }).
 *
 * When responseMode === "AUTO", this node is a transparent pass-through.
 */
import { interrupt } from "@langchain/langgraph";
import { logger } from "../../../utils/logger";
import type { AgentStateType } from "../agentState";

export async function hitlInterruptNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // AUTO mode: pass through with no interruption
  if (state.responseMode !== "MANUAL") return {};
  if (!state.decision) return {};

  logger.info("ai.node.hitlInterrupt.pausing", {
    businessProfileId: state.businessProfileId,
    channel: state.channel,
    action: state.decision.action,
  });

  // interrupt() pauses execution here.
  // The graph state is checkpointed to PostgreSQL.
  // Execution resumes when the dashboard calls graph.invoke with Command({ resume: ... })
  const humanApproval = interrupt({
    type:          "PENDING_HUMAN_REVIEW",
    draftContent:  state.decision.content,
    draftPublic:   state.decision.publicContent,
    draftPrivate:  state.decision.privateContent,
    reasoning:     state.decision.reasoning,
    businessProfileId: state.businessProfileId,
  });

  // humanApproval is the content returned by the human (approved or edited)
  const approvedContent = typeof humanApproval === "string"
    ? humanApproval
    : state.decision.content; // Fallback to AI draft if human sends no text

  logger.info("ai.node.hitlInterrupt.resumed", {
    businessProfileId: state.businessProfileId,
    wasEdited: approvedContent !== state.decision.content,
  });

  return {
    decision: {
      ...state.decision,
      content:        approvedContent,
      privateContent: approvedContent,
    },
    pendingHumanApproval: false,
  };
}
