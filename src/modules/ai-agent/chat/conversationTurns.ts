import { customerMessageForModel } from "./messageSignals";

/** Prior turns for the LLM (token budget). */
export const MAX_HISTORY_CHARS = 12_000;

interface Message {
  role: "user" | "model";
  content: string;
}

type ConversationTurnRow = {
  role: string;
  content: string;
  type?: string | null;
  mediaId?: string | null;
  mediaMetadata?: unknown;
};

/** Prisma stores `role` as String; narrow to prompt roles we persist. */
export function toPromptMessages(
  rows: ConversationTurnRow[],
): Message[] {
  return rows.map((m) => ({
    role: (m.role === "model" || m.role === "agent") ? "model" : "user",
    content:
      m.role === "model" || m.role === "agent"
        ? m.content
        : customerMessageForModel({
            messageText: m.content,
            mediaInfo:
              m.mediaId || m.mediaMetadata
                ? {
                    id: m.mediaId,
                    type: m.type,
                    metadata: m.mediaMetadata,
                  }
                : undefined,
          }),
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

