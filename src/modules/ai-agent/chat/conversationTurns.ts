/** Prior turns for the LLM (token budget). */
export const MAX_HISTORY_CHARS = 12_000;

interface Message {
  role: "user" | "model";
  content: string;
}

/** Prisma stores `role` as String; narrow to prompt roles we persist. */
export function toPromptMessages(
  rows: { role: string; content: string }[],
): Message[] {
  return rows.map((m) => ({
    role: (m.role === "model" || m.role === "agent") ? "model" : "user",
    content: m.content,
  }));
}

/**
 * Exclude the last user message — it is passed as `customerMessage` to the model.
 */
export function historyToLlmTurns(
  historyIncludingLatestUser: Message[],
): { role: "user" | "model"; text: string }[] {
  const prior = historyIncludingLatestUser.slice(0, -1);
  const turns: { role: "user" | "model"; text: string }[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i]!;
    const piece = m.content;
    if (used + piece.length > MAX_HISTORY_CHARS) break;
    turns.unshift({ role: m.role, text: piece });
    used += piece.length;
  }
  return turns;
}

