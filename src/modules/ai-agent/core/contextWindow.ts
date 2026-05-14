/**
 * Context Window Manager
 *
 * Prevents token-limit crashes by trimming conversation history to fit
 * within Gemini's context window before each graph invocation.
 *
 * Strategy: Walk backwards through history (most recent first),
 * accumulating turns until the token budget is exhausted. Always
 * keep at least the last 2 turns to maintain coherence, and preserve
 * Gemini's function-call adjacency rules.
 */
import type { GeminiContent } from "./agentState";

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

function estimateTurnTokens(turn: GeminiContent): number {
  return turn.parts.reduce((sum, part) => {
    if (part.text) return sum + estimateTokens(part.text);
    if (part.inlineData) return sum + 500; // Rough cost for inline media
    return sum + 50; // Function calls / responses
  }, 0);
}

function hasFunctionCall(turn: GeminiContent): boolean {
  return turn.parts.some((part) => Boolean(part.functionCall));
}

function hasFunctionResponse(turn: GeminiContent): boolean {
  return turn.parts.some((part) => Boolean(part.functionResponse));
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

function collectMandatoryTurnIndexes(history: GeminiContent[]): Set<number> {
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

    if (hasFunctionResponse(turn)) {
      // A function response must remain attached to its model function call,
      // and that model function call must remain attached to the preceding
      // user/function-response turn accepted by Gemini.
      addMandatoryIndex(indexes, queue, index - 1, history.length);
      addMandatoryIndex(indexes, queue, index - 2, history.length);
      continue;
    }

    if (hasFunctionCall(turn)) {
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
  history: GeminiContent[],
  systemTokens = 0,
): GeminiContent[] {
  if (history.length <= MIN_TURNS_TO_KEEP) return history;

  const budget = MAX_HISTORY_TOKENS - systemTokens;
  const windowed: GeminiContent[] = [];
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

