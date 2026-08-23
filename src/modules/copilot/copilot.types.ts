// src/modules/copilot/copilot.types.ts
export type CopilotEnvelope =
  | { type: "text"; text: string }
  | { type: "stat-grid"; items: { label: string; value: string | number; hint?: string }[] }
  | { type: "lead-list"; leads: { id: number; name: string; channel?: string | null; interest?: string | null; createdAt?: string }[]; total?: number }
  | { type: "conversation-list"; conversations: { id: number; customerName: string; channel?: string | null; handoffCategory?: string | null; preview?: string | null }[] }
  | { type: "progress"; message: string }
  | { type: "link-card"; title: string; description?: string; href: string; cta: string }
  | { type: "error"; message: string; retryable: boolean };

// Persisted assistant-message envelope. `truncated` is set when the graph hit
// MAX_TOOL_ROUNDS and the response is a partial success — the frontend uses it
// to render a "Got N of M" footer on reload. When `truncated` is true,
// `expectedTotal` carries the lower bound on what the model was trying to
// produce (tool rounds attempted + 1 for the cut-off final response), so the
// footer can render a meaningful "N of M" rather than "N of N". Both fields
// are optional for forward-compat with rows persisted before they existed.
export type CopilotMessagePayload = {
  envelopes: CopilotEnvelope[];
  truncated?: boolean;
  expectedTotal?: number;
};
