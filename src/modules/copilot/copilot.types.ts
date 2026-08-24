// src/modules/copilot/copilot.types.ts
export type EnvelopeCite = {
  tool: string;
  section?: string;
  fetchedAt: string;
  deepLink?: string;
};

export type CopilotEnvelope =
  | { type: "text"; text: string; cite?: EnvelopeCite }
  | { type: "stat-grid"; items: { label: string; value: string | number; hint?: string }[]; cite?: EnvelopeCite }
  | { type: "lead-list"; leads: Array<{
      id: number;
      name?: string | null;
      displayName?: string | null;
      channel?: string | null;
      primaryChannel?: string | null;
      interest?: string | null;
      phone?: string | null;
      [key: string]: unknown;
    }>; total?: number; cite?: EnvelopeCite }
  | { type: "conversation-list"; conversations: { id: number; customerName: string; channel?: string | null; handoffCategory?: string | null; preview?: string | null }[]; cite?: EnvelopeCite }
  | { type: "progress"; message: string }
  | { type: "link-card"; title: string; description?: string; href: string; cta: string; cite?: EnvelopeCite }
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
  trace?: { steps: { name: string; durationMs: number }[] };
};
