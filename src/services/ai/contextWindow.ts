/**
 * Context Window Manager
 *
 * Prevents token-limit crashes by trimming conversation history to fit
 * within Gemini's context window before each graph invocation.
 *
 * Strategy: Walk backwards through history (most recent first),
 * accumulating turns until the token budget is exhausted. Always
 * keep at least the last 2 turns to maintain coherence.
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

/**
 * Trims history to fit within the token budget.
 * Always preserves the most recent MIN_TURNS_TO_KEEP turns.
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

  // Walk backwards: most recent turns have highest priority
  for (let i = history.length - 1; i >= 0; i--) {
    const turnCost = estimateTurnTokens(history[i]);

    // Always keep the last MIN_TURNS_TO_KEEP turns regardless of budget
    const isMandatory = i >= history.length - MIN_TURNS_TO_KEEP;

    if (isMandatory || remaining - turnCost >= 0) {
      remaining -= turnCost;
      windowed.unshift(history[i]);
    } else {
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
