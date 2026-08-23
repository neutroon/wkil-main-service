import { Annotation } from "@langchain/langgraph";
import type { AgentContent, ToolCall } from "@modules/ai-agent/core/agentState";
import type { CopilotEnvelope } from "./copilot.types";

const overwrite = <T>(_prev: T, update: T) => update;
const addUsage = (
  prev: { promptTokens: number; completionTokens: number },
  u: { promptTokens: number; completionTokens: number },
) => ({ promptTokens: prev.promptTokens + u.promptTokens, completionTokens: prev.completionTokens + u.completionTokens });

export const CopilotState = Annotation.Root({
  userId: Annotation<number>(),
  conversationId: Annotation<number>(),
  locale: Annotation<"ar" | "en">(),
  mode: Annotation<"onboarding" | "general">(),
  onboardingStep: Annotation<string | null>({ value: overwrite, default: () => null }),
  contents: Annotation<AgentContent[]>({ value: overwrite, default: () => [] }),
  toolCalls: Annotation<ToolCall[]>({ value: overwrite, default: () => [] }),
  toolRounds: Annotation<number>({ value: overwrite, default: () => 0 }),
  toolResults: Annotation<{ name: string; result: unknown }[]>({ value: overwrite, default: () => [] }),
  rawText: Annotation<string>({ value: overwrite, default: () => "" }),
  envelopes: Annotation<CopilotEnvelope[]>({ value: overwrite, default: () => [] }),
  usage: Annotation<{ promptTokens: number; completionTokens: number }>({ value: addUsage, default: () => ({ promptTokens: 0, completionTokens: 0 }) }),
  modelName: Annotation<string>({ value: overwrite, default: () => "" }),
  emitDelta: Annotation<((d: string) => void) | undefined>({ value: overwrite, default: () => undefined }),
  emitProgress: Annotation<((m: string) => void) | undefined>({ value: overwrite, default: () => undefined }),
});

export type CopilotStateType = typeof CopilotState.State;
