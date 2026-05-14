/**
 * LangGraph Agent State Schema
 *
 * This is the single source of truth for all data flowing through the
 * PagesPilot AI agent graph. It replaces the 4 mutable variables that
 * were manually threaded through the while-loop in runAIEngineLoop:
 *   - turnCount
 *   - hadToolExecutionInTurn
 *   - evidence
 *   - contents (mutated via .push())
 *
 * Every node receives a read-only snapshot of this state and returns
 * only the fields it needs to update (Partial<AgentState>).
 * No node ever mutates state in place.
 */
import { Annotation } from "@langchain/langgraph";
import type { Tool } from "@google/genai";
import type {
  AiRoutingDecision,
  AiTruthfulnessPolicy,
  AiEvidenceState,
  DEFAULT_AI_TRUTHFULNESS_POLICY,
} from "./aiEngine.utils";

// ── Re-export convenience types ────────────────────────────────────────────────
export type { AiRoutingDecision, AiTruthfulnessPolicy, AiEvidenceState };

// ── Internal types used only by the graph ─────────────────────────────────────

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiPart {
  text?: string;
  inlineData?: { data: string; mimeType: string };
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}

export interface FunctionCall {
  id?: string;
  name: string;
  args: unknown;
}

export interface SessionStats {
  promptTokens: number;
  completionTokens: number;
  groundingCalls: number;
  lastBilledPromptTokens: number;
  lastBilledCompletionTokens: number;
  lastBilledGrounding: number;
  modelName: string;
}

export function makeEmptyEvidence(): AiEvidenceState {
  return {
    verifiedActions: [],
    unverifiedActions: [],
    failedActions: [],
    unknownActions: [],
  };
}

function makeDefaultStats(): SessionStats {
  return {
    promptTokens: 0,
    completionTokens: 0,
    groundingCalls: 0,
    lastBilledPromptTokens: 0,
    lastBilledCompletionTokens: 0,
    lastBilledGrounding: 0,
    modelName: "gemini-3-flash-preview",
  };
}

// ── The Graph State ────────────────────────────────────────────────────────────

export const AgentState = Annotation.Root({
  // ─── Read-only inputs (set at graph entry, never modified by nodes) ───────
  systemInstruction: Annotation<string>(),
  tools:             Annotation<Tool[] | undefined>(),
  businessProfileId: Annotation<number>(),
  businessName:      Annotation<string | undefined>(),
  businessVoice:     Annotation<string | undefined>(),
  businessTone:      Annotation<string | undefined>(),
  userId:            Annotation<number>(),
  customerPhone:     Annotation<string | undefined>(),
  channel:           Annotation<string | undefined>(),
  contextQuality:    Annotation<"specific_evidence_found" | "core_context_only" | "no_context" | undefined>(),
  availableChunkTypes: Annotation<string[]>({
    value:   (_, update) => update,
    default: () => [],
  }),
  externalSourceFailureBehaviors: Annotation<Record<number, string>>({
    value:   (_, update) => update,
    default: () => ({}),
  }),
  policy:            Annotation<AiTruthfulnessPolicy>(),
  handoffEnabled:    Annotation<boolean>({
    value:   (_, update) => update,
    default: () => true,
  }),
  conversationId:    Annotation<number | undefined>(),
  agentTurnId:       Annotation<number | undefined>(),
  activeWorkflowId:  Annotation<number | undefined>(),
  parentActionRunId: Annotation<number | undefined>(),
  actionStepKey:     Annotation<string | undefined>(),

  // ─── Mutable: conversation turns (append-only via reducer) ───────────────
  // Each node that adds a turn pushes to this array.
  // The reducer merges arrays — no node can accidentally overwrite history.
  contents: Annotation<GeminiContent[]>({
    value: (_, update) => update,
    default: () => [],
  }),

  // ─── Mutable: tool execution state ───────────────────────────────────────
  // Overwrite semantics: each callGemini turn sets this fresh.
  functionCalls: Annotation<FunctionCall[]>({
    value:   (_, update) => update,
    default: () => [],
  }),

  // ─── Mutable: loop counters and flags ────────────────────────────────────
  turnCount: Annotation<number>({
    value:   (_, update) => update,
    default: () => 0,
  }),
  hadToolExecution: Annotation<boolean>({
    value:   (_, update) => update,
    default: () => false,
  }),

  // ─── Mutable: evidence tracking for guardrails ───────────────────────────
  evidence: Annotation<AiEvidenceState>({
    value:   (_, update) => update,
    default: makeEmptyEvidence,
  }),

  // ─── Mutable: token / billing tracking ───────────────────────────────────
  sessionStats: Annotation<SessionStats>({
    value:   (_, update) => update,
    default: makeDefaultStats,
  }),

  // ─── Output: the final AI routing decision ───────────────────────────────
  decision: Annotation<AiRoutingDecision | null>({
    value:   (_, update) => update,
    default: () => null,
  }),

  queuedActionRunId: Annotation<number | undefined>({
    value:   (_, update) => update,
    default: () => undefined,
  }),

});

export type AgentStateType = typeof AgentState.State;

