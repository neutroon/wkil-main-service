import { Client, type Run } from "@langchain/langgraph-sdk";
import {
  customerAgentDecisionSchema,
  projectCustomerAgentContinuation,
  type CustomerAgentContinuationInput,
  type CustomerAgentDecision,
  type CustomerChannel,
} from "../customer/customerAgent.types";

const API_URL = process.env.LANGGRAPH_API_URL ?? "http://localhost:8123";
const RUN_TIMEOUT_MS = 45_000;
const CUSTOMER_RUN_SEARCH_PAGE_SIZE = 100;
const CUSTOMER_RUN_SEARCH_MAX_PAGES = 10;

export class CustomerAgentRunAbortedError extends Error {
  readonly code = "CUSTOMER_AGENT_RUN_ABORTED";

  constructor(reason: unknown) {
    super("Customer agent run aborted by caller", { cause: reason });
    this.name = "CustomerAgentRunAbortedError";
  }
}

export type CapabilityOperation = "customer_memory" | "business_identity" |
  "strategic_links" | "content_plan" |
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
};

// Prisma profile payloads contain persistence and integration fields that are
// not part of the agent contract. Keep the capability boundary explicit so a
// caller can safely pass a profile object without tripping strict schemas or
// leaking unrelated tenant data into a model prompt.
const BUSINESS_ALLOWED_KEYS = new Set([
  "name", "identity", "voice", "tone", "targetAudience", "target_audience",
  "productsServices", "products_services", "corePolicies", "core_policies",
  "aiBehaviorInstructions", "ai_behavior_instructions",
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
  if (operation === "media_understanding" && typeof value.text !== "string") {
    throw new Error("Agent capability media_understanding returned an invalid result");
  }
  if (operation === "strategic_links" && !Array.isArray(value.links)) {
    throw new Error("Agent capability strategic_links returned an invalid result");
  }
  return value as CapabilityResultMap[K];
}

export class AgentClient {
  private static client(): Client {
    const apiKey = process.env.MONOLITH_AGENT_API_KEY;
    if (!apiKey) throw new Error("MONOLITH_AGENT_API_KEY is required for backend agent calls");
    return new Client({ apiUrl: API_URL, apiKey });
  }

  static async createThread() { return this.client().threads.create(); }

  static async ensureCustomerThread(
    threadId: string,
    metadata: { businessProfileId: number; conversationId: number; channel: CustomerChannel },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client().threads.create({
      threadId,
      ifExists: "do_nothing",
      graphId: "customer_agent",
      ttl: { ttl: 90 * 24 * 60, strategy: "delete" },
      metadata: {
        business_profile_id: metadata.businessProfileId,
        conversation_id: metadata.conversationId,
        channel: metadata.channel,
      },
      signal,
    });
  }

  static async getCustomerThreadState(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const state = await this.client().threads.getState(threadId, undefined, { signal });
    if (!isRecord(state.values)) {
      throw new Error("Customer agent thread returned invalid state");
    }
    return state.values;
  }

  static async startCustomerRun(request: {
    threadId: string;
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    context: {
      userId: number;
      businessProfileId: number;
      conversationId: number;
      channel: CustomerChannel;
      runMode: "inbound" | "follow_up";
      continuation?: CustomerAgentContinuationInput | null;
      mediaContext?: string | null;
      followUpIndex?: number | null;
    };
    dedupeKey: string;
    signal?: AbortSignal;
  }): Promise<{ runId: string }> {
    const continuation = request.context.continuation == null
      ? undefined
      : projectCustomerAgentContinuation(request.context.continuation);
    const run = await this.client().runs.create(
      request.threadId,
      "customer_agent",
      {
        input: this.customerRunInput(request.messages, request.context),
        ...(continuation == null ? {} : { context: continuation }),
        multitaskStrategy: "enqueue",
        durability: "async",
        config: { recursion_limit: 6 },
        metadata: { dedupe_key: request.dedupeKey },
        signal: request.signal,
      },
    );
    this.assertRunnableStatus(run);
    return { runId: run.run_id };
  }

  static async findCustomerRunByDedupeKey(
    threadId: string,
    dedupeKey: string,
    signal?: AbortSignal,
  ): Promise<{ runId: string } | null> {
    for (let page = 0; page < CUSTOMER_RUN_SEARCH_MAX_PAGES; page += 1) {
      const runs = await this.client().runs.list(threadId, {
        limit: CUSTOMER_RUN_SEARCH_PAGE_SIZE,
        offset: page * CUSTOMER_RUN_SEARCH_PAGE_SIZE,
        signal,
      });
      // The SDK's list type does not guarantee ordering. Select the newest
      // valid match within this page; the durable lease makes the key unique.
      const match = runs
        .filter((run) => (
          typeof run.run_id === "string" && run.run_id.length > 0 &&
          isRecord(run.metadata) && run.metadata.dedupe_key === dedupeKey
        ))
        .sort((left, right) => this.compareCustomerRunsNewestFirst(left, right))[0];
      if (match) return { runId: match.run_id };
      if (runs.length < CUSTOMER_RUN_SEARCH_PAGE_SIZE) return null;
    }
    // Do not create a potentially duplicate run after an inconclusive bounded search.
    throw new Error("Customer agent run recovery search exceeded its safety limit");
  }

  static async joinCustomerRun(
    threadId: string,
    runId: string,
    options?: { signal?: AbortSignal },
  ): Promise<CustomerAgentDecision> {
    const controller = new AbortController();
    let callerAbortReason: unknown;
    let timedOut = false;
    let remoteRunTerminal = false;
    let joinResolvedAfterAbort = false;
    let cancellation: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lifecycleCleaned = false;
    const cleanupLifecycle = () => {
      if (lifecycleCleaned) return;
      lifecycleCleaned = true;
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    };
    const cancelExactRunOnce = () => {
      if (remoteRunTerminal || cancellation) return cancellation;
      cancellation = Promise.resolve()
        .then(() => this.cancelCustomerRun(threadId, runId))
        .catch(() => undefined);
      return cancellation;
    };
    const onAbort = () => {
      callerAbortReason = options?.signal?.reason;
      controller.abort(callerAbortReason);
    };
    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RUN_TIMEOUT_MS);
    try {
      const state = await this.client().runs.join(threadId, runId, {
        signal: controller.signal,
      }).then((joinedState) => {
        if (timedOut || options?.signal?.aborted) {
          joinResolvedAfterAbort = true;
        } else {
          // The remote join is the terminal boundary. From this point on,
          // caller aborts and timeout callbacks must not cancel the exact run.
          remoteRunTerminal = true;
        }
        cleanupLifecycle();
        return joinedState;
      }, (error: unknown) => {
        cleanupLifecycle();
        throw error;
      });
      if (joinResolvedAfterAbort) {
        await cancelExactRunOnce();
        if (timedOut) throw new Error("Customer agent run timed out");
        throw new CustomerAgentRunAbortedError(callerAbortReason);
      }
      const run = await this.client().runs.get(threadId, runId);
      if (run.status !== "success") throw new Error(`Customer agent run ${run.status}`);
      if (!isRecord(state) || !("structured_response" in state)) {
        throw new Error("Customer agent run is missing structured_response");
      }
      return customerAgentDecisionSchema.parse(state.structured_response);
    } catch (error: unknown) {
      if (timedOut && !remoteRunTerminal) {
        await cancelExactRunOnce();
        throw new Error(`Customer agent run timeout after ${RUN_TIMEOUT_MS}ms`);
      }
      if (options?.signal?.aborted && !remoteRunTerminal) {
        await cancelExactRunOnce();
        throw new CustomerAgentRunAbortedError(callerAbortReason);
      }
      throw error;
    } finally {
      cleanupLifecycle();
    }
  }

  static joinCustomerRunStream(
    threadId: string,
    runId: string,
    options?: { signal?: AbortSignal; cancelOnDisconnect?: boolean },
  ) {
    return this.client().runs.joinStream(threadId, runId, options);
  }

  static cancelCustomerRun(threadId: string, runId: string, signal?: AbortSignal): Promise<void> {
    return signal
      ? this.client().runs.cancel(threadId, runId, true, "interrupt", { signal })
      : this.client().runs.cancel(threadId, runId, true, "interrupt");
  }

  private static customerRunInput(
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    context: {
      userId: number;
      businessProfileId: number;
      conversationId: number;
      channel: CustomerChannel;
      runMode: "inbound" | "follow_up";
      continuation?: CustomerAgentContinuationInput | null;
      mediaContext?: string | null;
      followUpIndex?: number | null;
    },
  ): Record<string, unknown> {
    return {
      messages,
      user_id: context.userId,
      business_profile_id: context.businessProfileId,
      conversation_id: context.conversationId,
      channel: context.channel,
      run_mode: context.runMode,
      ...(context.mediaContext == null ? {} : { media_context: context.mediaContext }),
      ...(context.followUpIndex == null ? {} : { follow_up_index: context.followUpIndex }),
    };
  }

  private static compareCustomerRunsNewestFirst(left: Run, right: Run): number {
    const leftCreatedAt = this.validRunTimestamp(left.created_at);
    const rightCreatedAt = this.validRunTimestamp(right.created_at);
    if (leftCreatedAt !== null && rightCreatedAt !== null && leftCreatedAt !== rightCreatedAt) {
      return rightCreatedAt - leftCreatedAt;
    }
    if (leftCreatedAt !== null && rightCreatedAt === null) return -1;
    if (leftCreatedAt === null && rightCreatedAt !== null) return 1;
    return right.run_id.localeCompare(left.run_id);
  }

  private static validRunTimestamp(value: string): number | null {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

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
