import { END, START, StateGraph } from "@langchain/langgraph";
import { checkpointer } from "@modules/ai-agent/core/checkpointer";
import { streamDecisionOrTool } from "@modules/ai-agent/core/modelRuntime";
import type { AgentContent, AgentToolDefinition, ToolCall } from "@modules/ai-agent/core/agentState";
import { logger } from "@utils/logger";
import { emitToCopilot } from "@modules/realtime/socket";
import { getCopilotConversationForUser, listCopilotMessages } from "./copilot.store";
import { envelopesForToolResult } from "./copilot.cards";
import { buildCopilotSystemPrompt } from "./copilot.prompts";
import { CopilotState, type CopilotStateType } from "./copilot.state";
import { copilotTools, findCopilotTool } from "./copilot.tools";

const MAX_TOOL_ROUNDS = 5;

function emptyToolResult(name: string, error: string): { name: string; result: unknown } {
  return { name, result: { error } };
}

async function loadContext(state: CopilotStateType): Promise<Partial<CopilotStateType>> {
  const conv = await getCopilotConversationForUser(state.conversationId, state.userId);
  const messages = await listCopilotMessages(conv.id, 20);
  const contents: AgentContent[] = messages.map((m) => {
    const env = (m.envelope ?? {}) as any;
    if (m.role === "USER") return { role: "user", content: env.text ?? "" };
    // ASSISTANT — flatten text envelopes
    const list = Array.isArray(env.envelopes) ? env.envelopes : [];
    const text = list.filter((e: any) => e?.type === "text").map((e: any) => e.text).join("\n");
    return { role: "model", content: text };
  });
  return {
    mode: conv.kind === "ONBOARDING" ? "onboarding" : "general",
    onboardingStep: conv.onboardingStep ?? null,
    contents,
  };
}

function agentToolDefsForMode(mode: "onboarding" | "general"): AgentToolDefinition[] {
  // Filter onboarding tools out of general mode.
  const onboardingNames = new Set(["save_business_info", "scrape_website", "set_brand_kit", "finish_onboarding"]);
  return copilotTools
    .filter((t) => mode === "onboarding" || !onboardingNames.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
}

async function callModel(state: CopilotStateType): Promise<Partial<CopilotStateType>> {
  const systemInstruction = buildCopilotSystemPrompt({ mode: state.mode, locale: state.locale, onboardingStep: state.onboardingStep });
  const tools = agentToolDefsForMode(state.mode);
  const onTextDelta = (delta: string) => {
    state.emitDelta?.(delta);
    emitToCopilot(state.userId, "copilot:delta", { conversationId: state.conversationId, delta });
  };
  const out = await streamDecisionOrTool({
    pipeline: "copilot",
    systemInstruction,
    contents: state.contents,
    tools,
    onTextDelta,
  });
  return {
    toolCalls: out.toolCalls,
    rawText: out.rawText,
    usage: { promptTokens: out.usage.promptTokens, completionTokens: out.usage.completionTokens },
    modelName: out.modelName,
  };
}

async function executeTools(state: CopilotStateType): Promise<Partial<CopilotStateType>> {
  const newResults: { name: string; result: unknown }[] = [];
  const toolMessages: AgentContent[] = [];
  const ctx = {
    userId: state.userId,
    conversationId: state.conversationId,
    locale: state.locale,
    onProgress: (msg: string) => {
      state.emitProgress?.(msg);
      emitToCopilot(state.userId, "copilot:progress", { conversationId: state.conversationId, message: msg });
    },
  };
  for (const call of state.toolCalls as ToolCall[]) {
    const tool = findCopilotTool(call.name);
    let result: unknown;
    let args: any;
    try {
      args = tool ? tool.schema.parse(call.args) : call.args;
    } catch (err: any) {
      result = { error: `Invalid arguments: ${err?.message ?? "parse failed"}` };
    }
    if (result === undefined && tool) {
      try {
        result = await tool.handler(args, ctx);
      } catch (err: any) {
        result = { error: err?.message ?? "tool failed" };
        logger.error("copilot.tool_failed", { tool: call.name, error: err?.message });
      }
    } else if (!tool) {
      result = { error: `Unknown tool: ${call.name}` };
    }
    newResults.push({ name: call.name, result });
    toolMessages.push({ role: "tool", toolName: call.name, toolCallId: call.id ?? call.name, toolResult: result });
  }
  return {
    toolResults: newResults,
    contents: [...state.contents, ...toolMessages],
    toolRounds: state.toolRounds + 1,
  };
}

const CAP_ERROR: Record<"ar" | "en", string> = {
  ar: "وصلت لعدد كبير من الخطوات. حاول تاني من أول.",
  en: "I took too many steps trying to help. Try again from the top.",
};

function buildEnvelopes(state: CopilotStateType): Partial<CopilotStateType> {
  const cards = state.toolResults.flatMap((r) => envelopesForToolResult(r.name, r.result));
  const out: CopilotStateType["envelopes"] = [...cards];
  if (state.rawText) out.push({ type: "text", text: state.rawText });
  if (state.toolRounds >= MAX_TOOL_ROUNDS && !state.rawText) {
    out.push({ type: "error", message: CAP_ERROR[state.locale], retryable: true });
  }
  return { envelopes: out };
}

const workflow = new StateGraph(CopilotState)
  .addNode("loadContext", loadContext)
  .addNode("callModel", callModel)
  .addNode("executeTools", executeTools)
  .addNode("buildEnvelopes", buildEnvelopes);

workflow.addEdge(START, "loadContext");
workflow.addEdge("loadContext", "callModel");
workflow.addConditionalEdges("callModel", (state) =>
  state.toolCalls.length > 0 && state.toolRounds < MAX_TOOL_ROUNDS ? "executeTools" : "buildEnvelopes"
);
workflow.addEdge("executeTools", "callModel");
workflow.addEdge("buildEnvelopes", END);

export const copilotGraph = workflow.compile({ checkpointer });

export async function runCopilotGraph(params: {
  conversationId: number;
  userId: number;
  locale: "ar" | "en";
  text: string;
}): Promise<{
  envelopes: import("./copilot.types").CopilotEnvelope[];
  usage: { promptTokens: number; completionTokens: number };
  modelName: string;
}> {
  const final = await copilotGraph.invoke(
    // `contents` starts empty: the orchestrator persists the user message
    // before invoking (Task 10), so `loadContext` sources the full history
    // — including the new message — from the store.
    { conversationId: params.conversationId, userId: params.userId, locale: params.locale },
    { configurable: { thread_id: `copilot-${params.conversationId}`, graph_version: "copilot-v1" } },
  );
  return { envelopes: final.envelopes, usage: final.usage, modelName: final.modelName };
}
