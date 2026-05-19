/**
 * Context Window Manager
 *
 * Prevents token-limit crashes by trimming conversation history to fit
 * within the model context window before each graph invocation.
 *
 * Strategy: Walk backwards through history (most recent first),
 * accumulating turns until the token budget is exhausted. Always
 * keep at least the last 2 turns to maintain coherence, and preserve
 * tool-call adjacency rules.
 */
import type { AgentContent } from "./agentState";

// Reserve 2048 tokens for the model's completion output.
// Reserve another 1000 for the system instruction.
// Leave the rest for history.
const MAX_HISTORY_TOKENS = 5000;
const MIN_TURNS_TO_KEEP  = 2;

/**
 * Rough token estimator: ~4 characters per token (GPT/Gemini standard heuristic).
 * This is intentionally conservative (slight overestimate) to avoid edge cases.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTurnTokens(turn: AgentContent): number {
  let total = estimateTokens(turn.content || "");
  if (turn.inlineData) total += 500; // Rough cost for inline media
  if (turn.toolCalls?.length) total += 50 * turn.toolCalls.length;
  if (turn.toolResult) total += estimateTokens(JSON.stringify(turn.toolResult));
  return total;
}

function hasToolCall(turn: AgentContent): boolean {
  return Boolean(turn.toolCalls?.length);
}

function hasToolResponse(turn: AgentContent): boolean {
  return turn.role === "tool";
}

function addMandatoryIndex(
  indexes: Set<number>,
  queue: number[],
  index: number,
  historyLength: number,
) {
  if (index < 0 || index >= historyLength || indexes.has(index)) return;
  indexes.add(index);
  queue.push(index);
}

function collectMandatoryTurnIndexes(history: AgentContent[]): Set<number> {
  const indexes = new Set<number>();
  const queue: number[] = [];

  for (
    let i = Math.max(0, history.length - MIN_TURNS_TO_KEEP);
    i < history.length;
    i++
  ) {
    addMandatoryIndex(indexes, queue, i, history.length);
  }

  while (queue.length > 0) {
    const index = queue.pop()!;
    const turn = history[index];

    if (hasToolResponse(turn)) {
      // A tool response must remain attached to its model tool call,
      // and that model tool call must remain attached to the preceding
      // user/tool-response turn accepted by the provider.
      addMandatoryIndex(indexes, queue, index - 1, history.length);
      addMandatoryIndex(indexes, queue, index - 2, history.length);
      continue;
    }

    if (hasToolCall(turn)) {
      addMandatoryIndex(indexes, queue, index - 1, history.length);
    }
  }

  return indexes;
}

/**
 * Trims history to fit within the token budget.
 * Always preserves the most recent MIN_TURNS_TO_KEEP turns and any adjacent
 * turns required to keep function-call/function-response history valid.
 *
 * @param history     Full conversation history
 * @param systemTokens  Token count of the system instruction (to deduct from budget)
 * @returns Windowed history that fits within the token budget
 */
export function windowContents(
  history: AgentContent[],
  systemTokens = 0,
): AgentContent[] {
  if (history.length <= MIN_TURNS_TO_KEEP) return history;

  const budget = MAX_HISTORY_TOKENS - systemTokens;
  const windowed: AgentContent[] = [];
  let remaining = budget;
  const mandatoryIndexes = collectMandatoryTurnIndexes(history);
  const earliestMandatory = Math.min(...mandatoryIndexes);

  // Walk backwards: most recent turns have highest priority
  for (let i = history.length - 1; i >= 0; i--) {
    const turnCost = estimateTurnTokens(history[i]);
    const isMandatory = mandatoryIndexes.has(i);

    if (isMandatory || remaining - turnCost >= 0) {
      remaining -= turnCost;
      windowed.unshift(history[i]);
    } else if (i < earliestMandatory) {
      // Budget exhausted — stop here
      break;
    }
  }

  return windowed;
}

/**
 * Estimates the token cost of a system instruction string.
 */
export function estimateSystemTokens(systemInstruction: string): number {
  return estimateTokens(systemInstruction);
}

