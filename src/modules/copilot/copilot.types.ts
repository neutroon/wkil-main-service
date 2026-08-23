// src/modules/copilot/copilot.types.ts
export type CopilotEnvelope =
  | { type: "text"; text: string }
  | { type: "stat-grid"; items: { label: string; value: string | number; hint?: string }[] }
  | { type: "lead-list"; leads: { id: number; name: string; channel?: string | null; interest?: string | null; createdAt?: string }[]; total?: number }
  | { type: "conversation-list"; conversations: { id: number; customerName: string; channel?: string | null; handoffCategory?: string | null; preview?: string | null }[] }
  | { type: "progress"; message: string }
  | { type: "link-card"; title: string; description?: string; href: string; cta: string }
  | { type: "error"; message: string; retryable: boolean };

export type CopilotMessagePayload = { envelopes: CopilotEnvelope[] };
