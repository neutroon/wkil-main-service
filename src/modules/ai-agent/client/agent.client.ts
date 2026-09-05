import { Client, type Run } from "@langchain/langgraph-sdk";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:8123";
const RUN_TIMEOUT_MS = 45_000;

export type CapabilityOperation = "customer_memory" | "business_identity" |
  "strategic_links" | "follow_up" | "customer_reply" | "content_plan" |
  "content_post" | "content_audit" | "media_understanding";

export type CapabilityResultMap = {
  customer_memory: {
    profile_updates?: { name?: string | null; phone?: string | null; email?: string | null } | null;
    field_updates?: Record<string, string | number | boolean> | null;
    notes?: string | null;
  };
  business_identity: {
    name: string; identity: string; target_audience: string;
    voice: string; tone: string; products_services: string[];
    core_policies: string; confidence: number;
  };
  strategic_links: { links: Array<{ url: string; label: string; reason?: string }> };
  follow_up: { content: string };
  customer_reply: {
    action: "REPLY_AUTO" | "HANDOFF_TO_HUMAN" | "RESOLVE_CONVERSATION";
    content?: string | null;
    reasoning?: string;
    handoff_category?: string | null;
    reply_type?: string | null;
    attachment?: { asset_name: string; caption?: string | null } | null;
  };
  content_plan: {
    goals: string[];
    posts: Array<{
      scheduled_at: string; pillar: string; topic: string; format: string;
      funnel_stage?: string; content_goal?: string; cta?: string;
      rationale?: string; caption?: string; image_prompt?: string;
    }>;
  };
  content_post: {
    caption: string; hashtags: string[]; suggested_image?: string | null;
    image_prompt: string; reel_script?: string | null;
    carousel_slides?: Array<Record<string, unknown>> | null;
  };
  content_audit: {
    findings: string[]; gap_questions: string[];
    draft_brief: Record<string, unknown>; confidence_score: number;
  };
  media_understanding: { text: string };
};

export type CapabilityRequest<K extends CapabilityOperation> = {
  userId: number;
  businessProfileId: number;
  operation: K;
  context: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CONTEXT_KEYS: Record<string, string> = {
  latestCustomerMessage: "latest_customer_message",
  recentMessages: "recent_messages",
  customFields: "custom_fields",
  memoryInstructions: "memory_instructions",
  currentCustomer: "current_customer",
  baseUrl: "base_url",
  pageContent: "page_content",
  delayIndex: "delay_index",
  messageText: "message_text",
  historyTurns: "history_turns",
  mediaInfo: "media_info",
  conversationId: "conversation_id",
  startDate: "start_date",
  endDate: "end_date",
  postCount: "post_count",
  additionalContext: "additional_context",
  currentTrends: "current_trends",
  mimeType: "mime_type",
  dataBase64: "data_base64",
};
const BUSINESS_KEYS: Record<string, string> = {
  targetAudience: "target_audience",
  productsServices: "products_services",
  corePolicies: "core_policies",
  aiBehaviorInstructions: "ai_behavior_instructions",
  followUpMode: "follow_up_mode",
  followUpInstructions: "follow_up_instructions",
};

// Prisma profile payloads contain persistence and integration fields that are
// not part of the agent contract. Keep the capability boundary explicit so a
// caller can safely pass a profile object without tripping strict schemas or
// leaking unrelated tenant data into a model prompt.
const BUSINESS_ALLOWED_KEYS = new Set([
  "name", "identity", "voice", "tone", "targetAudience", "target_audience",
  "productsServices", "products_services", "corePolicies", "core_policies",
  "aiBehaviorInstructions", "ai_behavior_instructions", "followUpMode",
  "follow_up_mode", "followUpInstructions", "follow_up_instructions",
]);

function capabilityContext(value: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(value).map(([key, child]) => {
    if (key === "business" && isRecord(child)) {
      return [key, Object.fromEntries(Object.entries(child)
        .filter(([businessKey]) => BUSINESS_ALLOWED_KEYS.has(businessKey))
        .map(([businessKey, businessValue]) => [
          BUSINESS_KEYS[businessKey] ?? businessKey,
          businessValue,
        ]))];
    }
    return [CONTEXT_KEYS[key] ?? key, child];
  });
  return Object.fromEntries(entries);
}

function validateResult<K extends CapabilityOperation>(operation: K, value: unknown): CapabilityResultMap[K] {
  if (!isRecord(value)) throw new Error(`Agent capability ${operation} returned an invalid result`);
  if (operation === "follow_up" && typeof value.content !== "string") {
    throw new Error("Agent capability follow_up returned an invalid result");
  }
  if (operation === "media_understanding" && typeof value.text !== "string") {
    throw new Error("Agent capability media_understanding returned an invalid result");
  }
  if (operation === "customer_reply" && ![
    "REPLY_AUTO", "HANDOFF_TO_HUMAN", "RESOLVE_CONVERSATION",
  ].includes(String(value.action))) {
    throw new Error("Agent capability customer_reply returned an invalid result");
  }
  if (operation === "strategic_links" && !Array.isArray(value.links)) {
    throw new Error("Agent capability strategic_links returned an invalid result");
  }
  return value as CapabilityResultMap[K];
}

export class AgentClient {
  static enabled() { return process.env.USE_AGENT_SERVICE === "true"; }

  private static client(): Client {
    const apiKey = process.env.MONOLITH_AGENT_API_KEY;
    if (!apiKey) throw new Error("MONOLITH_AGENT_API_KEY is required for backend agent calls");
    return new Client({ apiUrl: API_URL, apiKey });
  }

  static async createThread() { return this.client().threads.create(); }

  private static async completedRun(graph: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = this.client();
    const thread = await client.threads.create();
    const run = await client.runs.create(thread.thread_id, graph, { input });
    this.assertRunnableStatus(run);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    try {
      const state = await client.runs.join(thread.thread_id, run.run_id, { signal: controller.signal });
      const completed = await client.runs.get(thread.thread_id, run.run_id, { signal: controller.signal });
      if (completed.status !== "success") throw new Error(`Agent capability run ${completed.status}`);
      if (!isRecord(state)) throw new Error("Agent capability run returned invalid state");
      return state;
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        await client.runs.cancel(thread.thread_id, run.run_id, true, "interrupt").catch(() => undefined);
        throw new Error(`Agent capability run timeout after ${RUN_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private static assertRunnableStatus(run: Run): void {
    if (["error", "timeout", "interrupted"].includes(run.status)) {
      throw new Error(`Agent capability run ${run.status}`);
    }
  }

  static async runCapability<K extends CapabilityOperation>(request: CapabilityRequest<K>): Promise<CapabilityResultMap[K]> {
    if (!Number.isInteger(request.userId) || request.userId <= 0) {
      throw new Error("A positive canonical userId is required for capability calls");
    }
    if (!Number.isInteger(request.businessProfileId) || request.businessProfileId <= 0) {
      throw new Error("A positive canonical businessProfileId is required for capability calls");
    }
    const state = await this.completedRun("capability", {
      user_id: request.userId,
      business_profile_id: request.businessProfileId,
      operation: request.operation,
      context: capabilityContext(request.context),
    });
    if (!("result" in state)) throw new Error(`Agent capability ${request.operation} is missing a result`);
    return validateResult(request.operation, state.result);
  }

  static runCopilot(input: Record<string, unknown>) { return this.completedRun("agent", input); }
  static runCustomerAgent(input: Record<string, unknown>) { return this.completedRun("customer_agent", input); }

  static runContentGeneration(kind: "plan" | "post" | "audit", context: Record<string, unknown>) {
    const operation = kind === "plan" ? "content_plan" : kind === "post" ? "content_post" : "content_audit";
    return this.runCapability({
      userId: Number(context.user_id),
      businessProfileId: Number(context.business_profile_id),
      operation,
      context,
    });
  }

  static ingestRag(payload: Record<string, unknown>) { return this.completedRun("rag_ingest", payload); }
}
