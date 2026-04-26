/**
 * PagesPilot AI Agent Graph
 *
 * This is the LangGraph StateGraph that replaces the manual while-loop
 * in runAIEngineLoop(). It wires the 6 production-grade nodes together
 * with typed conditional edges.
 *
 * Entry point: runAgentGraph() — identical signature to runAIEngineLoop().
 * Drop-in replacement with a graceful fallback to the legacy loop.
 *
 * Graph topology:
 *   START → callGemini → [runTools → callGemini (loop)]
 *                      → parseDecision → [runGuardrail] → hitlInterrupt → recordUsage → END
 */
import { StateGraph, START, END }        from "@langchain/langgraph";
import { PostgresSaver }               from "@langchain/langgraph-checkpoint-postgres";
import { Pool }                        from "pg";
import { AgentState }                    from "./agentState";
import { callGeminiNode }                from "./nodes/callGemini";
import { runToolsNode }                  from "./nodes/runTools";
import { parseDecisionNode }             from "./nodes/parseDecision";
import { runGuardrailNode }              from "./nodes/runGuardrail";
import { hitlInterruptNode }             from "./nodes/hitlInterrupt";
import { recordUsageNode }               from "./nodes/recordUsage";
import { DEFAULT_AI_TRUTHFULNESS_POLICY, runAIEngineLoop } from "./aiEngine.service";
import { assertQuotaAvailable }          from "../billing.service";
import { logger }                        from "../../utils/logger";
import prisma                            from "../../config/prisma";
import { estimateSystemTokens }          from "./contextWindow";
import type { Tool }                     from "@google/genai";
import type { AiRoutingDecision, AiTruthfulnessPolicy } from "./aiEngine.service";

const MAX_TURNS = 3;

// ── Persistence Layer (PostgreSQL) ──────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10, // Limit connections for checkpointer
});

export const checkpointer = new PostgresSaver(pool);

// ── Build the Graph ────────────────────────────────────────────────────────────

const workflow = new StateGraph(AgentState)
  .addNode("callGemini",    callGeminiNode)
  .addNode("runTools",      runToolsNode)
  .addNode("parseDecision", parseDecisionNode)
  .addNode("runGuardrail",  runGuardrailNode)
  .addNode("hitlInterrupt", hitlInterruptNode)
  .addNode("recordUsage",   recordUsageNode);

// ── Edges ──────────────────────────────────────────────────────────────────────

// Entry point
workflow.addEdge(START, "callGemini");

// After callGemini: if Gemini returned tool calls → execute tools
//                  if Gemini returned a final answer → parse it
workflow.addConditionalEdges("callGemini", (state) => {
  // If the node set a decision directly (timeout/error), skip to hitl
  if (state.decision !== null) return "hitlInterrupt";
  // Tool calls present → execute them
  if (state.functionCalls.length > 0) return "runTools";
  // Final text answer → parse it
  return "parseDecision";
});

// After runTools: loop back to callGemini for the next turn
// Safety exit: if we've hit MAX_TURNS, force parse whatever we have
workflow.addConditionalEdges("runTools", (state) => {
  if (state.turnCount >= MAX_TURNS) return "parseDecision";
  return "callGemini";
});

// After parseDecision: if tools were executed, run guardrail check
//                      otherwise go straight to hitlInterrupt
workflow.addConditionalEdges("parseDecision", (state) => {
  if (state.hadToolExecution) return "runGuardrail";
  return "hitlInterrupt";
});

// After runGuardrail: always proceed to hitlInterrupt
workflow.addEdge("runGuardrail", "hitlInterrupt");

// After hitlInterrupt: always record usage and exit
workflow.addEdge("hitlInterrupt", "recordUsage");

// Terminal node → END
workflow.addEdge("recordUsage", END);

// Compile with Postgres checkpointer for multi-turn persistence
export const agentGraph = workflow.compile({ checkpointer });

// ── Public API ─────────────────────────────────────────────────────────────────

export interface AgentGraphParams {
  systemInstruction: string;
  historyTurns:      { role: "user" | "model"; text?: string; parts?: any[] }[];
  customerMessage:   string;
  tools?:            Tool[];
  businessProfileId: number;
  customerPhone?:    string;
  channel?:          "messenger" | "whatsapp" | "web" | "facebook_comment";
  policy?:           Partial<AiTruthfulnessPolicy>;
  responseMode?:     "AUTO" | "MANUAL";
  mediaInfo?:        { id: string; type: string; url?: string };
  conversationId?:   number;
}

/**
 * runAgentGraph — drop-in replacement for runAIEngineLoop.
 *
 * Safety features:
 * 1. LANGGRAPH_ENABLED=false in .env → instantly falls back to legacy loop (no deploy needed)
 * 2. Any unhandled graph error → automatic fallback to legacy loop
 * Remove the fallback after 2 weeks of stable production operation.
 */
export async function runAgentGraph(
  params: AgentGraphParams,
): Promise<AiRoutingDecision> {
  // ── Kill-switch: bypass the graph entirely if disabled ──────────────────
  const isEnabled = process.env.LANGGRAPH_ENABLED !== "false";
  if (!isEnabled) {
    logger.info("ai.graph.disabled_by_flag");
    return runAIEngineLoop({
      systemInstruction: params.systemInstruction,
      historyTurns:      params.historyTurns,
      customerMessage:   params.customerMessage,
      tools:             params.tools,
      businessProfileId: params.businessProfileId,
      customerPhone:     params.customerPhone,
      channel:           params.channel as any,
      policy:            params.policy,
      mediaInfo:         params.mediaInfo,
    });
  }

  try {
    return await _runGraph(params);
  } catch (graphError: any) {
    logger.error("ai.graph.fallback_activated", {
      error: graphError.message,
      businessProfileId: params.businessProfileId,
    });
    // ── Graceful degradation: fall back to the legacy loop ──────────────
    return runAIEngineLoop({
      systemInstruction: params.systemInstruction,
      historyTurns:      params.historyTurns,
      customerMessage:   params.customerMessage,
      tools:             params.tools,
      businessProfileId: params.businessProfileId,
      customerPhone:     params.customerPhone,
      channel:           params.channel as any,
      policy:            params.policy,
      mediaInfo:         params.mediaInfo,
    });
  }
}

async function _runGraph(params: AgentGraphParams): Promise<AiRoutingDecision> {
  // ── Pre-flight quota check (same as legacy) ────────────────────────────
  const profile = await prisma.businessProfile.findUnique({
    where:  { id: params.businessProfileId },
    select: { userId: true },
  });
  if (!profile) throw new Error("Business profile not found");

  await assertQuotaAvailable(profile.userId, params.businessProfileId);

  const policy = {
    ...DEFAULT_AI_TRUTHFULNESS_POLICY,
    ...(params.policy ?? {}),
    fallbackTemplates: {
      ...DEFAULT_AI_TRUTHFULNESS_POLICY.fallbackTemplates,
      ...(params.policy?.fallbackTemplates ?? {}),
    },
  };

  // ── Build initial contents (history + current user message) ───────────
  const userParts: any[] = [{ text: params.customerMessage || "" }];

  // Media attachment is handled inside callGemini node (Phase 2 enhancement)
  // For Phase 1, media is passed via the legacy path if present.
  // TODO Phase 2: move media fetching into a dedicated prepareMedia node.

  const historyContents = params.historyTurns.map((t) => ({
    role:  t.role,
    parts: t.parts ? t.parts : [{ text: t.text ?? "" }],
  }));

  const initialContents = [
    ...historyContents,
    { role: "user" as const, parts: userParts },
  ];

  // ── Persistence Setup ──────────────────────────────────────────────────
  // Ensure checkpointer tables exist (runs once)
  try {
    await checkpointer.setup();
  } catch (err: any) {
    logger.warn("ai.graph.checkpointer_setup_failed", { error: err.message });
  }

  // ── Invoke the graph ───────────────────────────────────────────────────
  // Use conversationId as the threadId to maintain state across events
  const threadId = params.conversationId?.toString() || `temp_${Date.now()}`;

  const finalState = await agentGraph.invoke(
    {
      // Read-only inputs
      systemInstruction: params.systemInstruction,
      tools:             params.tools,
      businessProfileId: params.businessProfileId,
      userId:            profile.userId,
      customerPhone:     params.customerPhone,
      channel:           params.channel,
      policy,
      responseMode:      params.responseMode ?? "AUTO",
      // Initial mutable state
      // For fields with custom reducers, the initial value is passed directly.
      // LangGraph uses the value reducer on every subsequent update.
      contents:          initialContents as any,
      functionCalls:     [] as any,
      turnCount:         0 as any,
      hadToolExecution:  false as any,
      sessionStats: {
        promptTokens:     0,
        completionTokens: 0,
        groundingCalls:   0,
        modelName:        "gemini-3-flash-preview",
      } as any,
    },
    {
      configurable: {
        thread_id:     threadId,
        graph_version: "v1", // Bump on schema changes
      },
    },
  );

  return finalState.decision!;
}

/**
 * resumeAgentGraph — resumes an interrupted graph with human approval/edits.
 */
export async function resumeAgentGraph(
  conversationId: number,
  approvedContent: string,
): Promise<AiRoutingDecision> {
  const { Command } = await import("@langchain/langgraph");

  const finalState = await agentGraph.invoke(
    new Command({ resume: approvedContent }),
    {
      configurable: {
        thread_id:     conversationId.toString(),
        graph_version: "v1",
      },
    },
  );

  if (!finalState.decision) {
    throw new Error("Graph resumed but failed to produce a decision");
  }

  return finalState.decision!;
}


