import { Readable } from "node:stream";
import type { Response } from "express";
import type { AuthRequest } from "@modules/auth/core/auth.middleware";
import {
  getActiveProfileId,
  requireWorkspaceProfileAccess,
} from "@modules/workspace/workspace.service";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";

const ASSISTANT_GRAPH = "agent";
const MAX_MESSAGE_LENGTH = 16000;
const MAX_IMAGE_URL_LENGTH = 1_500_000;
const MAX_TITLE_LENGTH = 200;

type GatewayEndpoint =
  | "create"
  | "search"
  | "read"
  | "update"
  | "delete"
  | "state"
  | "history"
  | "run"
  | "cancel";

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(value: PlainRecord, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validParts(parts: readonly string[]): boolean {
  return parts.length > 0 && parts.every((part) => /^[a-zA-Z0-9_-]+$/.test(part));
}

function endpointFor(parts: readonly string[], method: string): GatewayEndpoint | undefined {
  if (!validParts(parts) || parts[0] !== "threads") return undefined;
  if (parts.length === 1 && method === "POST") return "create";
  if (parts.length === 2 && parts[1] === "search" && method === "POST") return "search";
  if (parts.length === 2 && ["GET", "PATCH", "DELETE"].includes(method)) {
    return method === "GET" ? "read" : method === "PATCH" ? "update" : "delete";
  }
  if (parts.length === 3 && parts[2] === "state" && method === "GET") return "state";
  if (parts.length === 3 && parts[2] === "history" && method === "POST") {
    return "history";
  }
  if (parts.length === 4 && parts[2] === "runs" && parts[3] === "stream" && method === "POST") return "run";
  if (parts.length === 5 && parts[2] === "runs" && parts[4] === "cancel" && method === "POST") return "cancel";
  return undefined;
}

function textFromMessageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is { type?: unknown; text?: unknown } => isPlainRecord(part))
    .filter((part) => part.type === "text" || part.type === "text_delta")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

type AssistantContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: string | { url: string; detail?: "auto" | "low" | "high" } };

function imageUrl(value: unknown): string | { url: string; detail?: "auto" | "low" | "high" } | undefined {
  if (typeof value === "string") return value;
  if (!isPlainRecord(value) || typeof value.url !== "string") return undefined;
  const detail = value.detail;
  return detail === undefined || ["auto", "low", "high"].includes(String(detail))
    ? { url: value.url, ...(detail === undefined ? {} : { detail: detail as "auto" | "low" | "high" }) }
    : undefined;
}

function isAllowedImageUrl(value: string): boolean {
  if (!value || value.length > MAX_IMAGE_URL_LENGTH) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "data:") return value.toLowerCase().startsWith("data:image/");
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeMessageContent(value: unknown): string | AssistantContentPart[] {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) throw new AppError("Message content is invalid", 400, true, "INVALID_HUMAN_MESSAGE");

  const parts: AssistantContentPart[] = [];
  let textLength = 0;
  for (const rawPart of value) {
    if (!isPlainRecord(rawPart)) {
      throw new AppError("Message content is invalid", 400, true, "INVALID_HUMAN_MESSAGE");
    }
    if (rawPart.type === "text" || rawPart.type === "text_delta") {
      const text = typeof rawPart.text === "string" ? rawPart.text : "";
      textLength += text.trim().length;
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (rawPart.type === "image_url" || rawPart.type === "image") {
      const rawImage = rawPart.type === "image_url" ? rawPart.image_url : rawPart.image;
      const url = imageUrl(rawImage);
      const normalizedUrl = typeof url === "string" ? url : url?.url;
      if (!url || !normalizedUrl || !isAllowedImageUrl(normalizedUrl)) {
        throw new AppError("Image attachments must use a valid http(s) or image data URL", 400, true, "INVALID_IMAGE_ATTACHMENT");
      }
      parts.push({ type: "image_url", image_url: url });
      continue;
    }
    throw new AppError("Unsupported message content", 400, true, "UNSUPPORTED_MESSAGE_CONTENT");
  }

  if (textLength > MAX_MESSAGE_LENGTH || parts.length === 0 ||
      (!parts.some((part) => part.type === "text") && !parts.some((part) => part.type === "image_url"))) {
    throw new AppError("Message must contain text or an image", 400, true, "INVALID_HUMAN_MESSAGE");
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("").trim();
  }
  return parts;
}

function approval(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "string") {
    return ["true", "false", "approved", "denied", "allow", "reject"].includes(value);
  }
  return isPlainRecord(value) &&
    hasOnly(value, ["approved", "decision"]) &&
    (typeof value.approved === "boolean" ||
      ["approved", "denied", "allow", "reject"].includes(String(value.decision)));
}

function validTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TITLE_LENGTH;
}

function clientTitle(value: unknown): string | undefined {
  if (!isPlainRecord(value) || !validTitle(value.title)) return undefined;
  return validTitle(value.title) ? value.title.trim() : undefined;
}

function deterministicThreadTitle(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  const boundary = cut.lastIndexOf(" ");
  return `${cut.slice(0, boundary > 20 ? boundary : 48)}…`;
}

function automaticTitleFromRun(normalized: PlainRecord | undefined): string | undefined {
  if (!normalized || normalized.command !== undefined) return undefined;
  const input = isPlainRecord(normalized.input) ? normalized.input : undefined;
  const messages = input && Array.isArray(input.messages) ? input.messages : [];
  const message = messages[0];
  if (!isPlainRecord(message)) return undefined;
  const text = textFromMessageContent(message.content);
  const title = deterministicThreadTitle(text);
  return title || undefined;
}

type TitleFetch = (
  input: string,
  init?: RequestInit,
) => Promise<globalThis.Response>;

type EnsureThreadTitleParams = {
  apiUrl: string;
  threadId: string;
  title: string;
  headers: Headers;
  signal: AbortSignal;
  fetchImpl?: TitleFetch;
};

function stateFirstHumanTitle(value: unknown): { found: boolean; title?: string } {
  if (!isPlainRecord(value) || !isPlainRecord(value.values) || !Array.isArray(value.values.messages)) {
    return { found: false };
  }

  for (const message of value.values.messages) {
    if (!isPlainRecord(message) || !["human", "user"].includes(String(message.type ?? message.role))) {
      continue;
    }
    const text = textFromMessageContent(message.content);
    const title = deterministicThreadTitle(text);
    return { found: true, ...(title ? { title } : {}) };
  }
  return { found: false };
}

async function ensureThreadTitle(params: EnsureThreadTitleParams): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const threadUrl = `${params.apiUrl}/threads/${encodeURIComponent(params.threadId)}`;

  try {
    const readHeaders = new Headers(params.headers);
    readHeaders.delete("content-type");
    const threadResponse = await fetchImpl(threadUrl, {
      method: "GET",
      headers: readHeaders,
      signal: params.signal,
    });
    if (!threadResponse.ok) {
      logger.warn("assistant.gateway.title_read_failed", { status: threadResponse.status });
      return;
    }

    const thread = await threadResponse.json() as unknown;
    const metadata = isPlainRecord(thread) && isPlainRecord(thread.metadata)
      ? thread.metadata
      : undefined;
    if (metadata && validTitle(metadata.title)) return;

    let title = params.title;
    try {
      const stateResponse = await fetchImpl(`${threadUrl}/state`, {
        method: "GET",
        headers: readHeaders,
        signal: params.signal,
      });
      if (stateResponse.ok) {
        const state = stateFirstHumanTitle(await stateResponse.json() as unknown);
        if (state.found) title = state.title ?? "";
      }
    } catch (error) {
      logger.warn("assistant.gateway.title_state_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!title) return;
    const patchHeaders = new Headers(params.headers);
    patchHeaders.set("content-type", "application/json");
    const updateResponse = await fetchImpl(threadUrl, {
      method: "PATCH",
      headers: patchHeaders,
      body: JSON.stringify({ metadata: { title } }),
      signal: params.signal,
    });
    if (!updateResponse.ok) {
      logger.warn("assistant.gateway.title_update_failed", { status: updateResponse.status });
    }
  } catch (error) {
    logger.warn("assistant.gateway.title_persistence_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeHumanMessage(value: unknown, userId: number): {
  type: "human";
  content: string | AssistantContentPart[];
  id: string;
} {
  if (!isPlainRecord(value) || !["human", "user"].includes(String(value.type ?? value.role))) {
    throw new AppError("Exactly one human message is required", 400, true, "ONE_HUMAN_MESSAGE_REQUIRED");
  }
  const content = normalizeMessageContent(value.content);
  const text = textFromMessageContent(content).trim();
  if ((!text && typeof content === "string") ||
      (typeof content === "string" && content.length > MAX_MESSAGE_LENGTH)) {
    throw new AppError("Message must contain 1-16000 characters or an image", 400, true, "INVALID_HUMAN_MESSAGE");
  }
  const suppliedId = typeof value.id === "string" ? value.id.slice(0, 128) : crypto.randomUUID();
  return {
    type: "human",
    content,
    id: `human:${userId}:${suppliedId}`,
  };
}

function normalizeHistoryBody(body: unknown): PlainRecord {
  if (body === undefined) return { limit: 10 };
  if (!isPlainRecord(body)) {
    throw new AppError("Invalid request body", 400, true, "INVALID_BODY");
  }
  // The SDK also types checkpoint/metadata cursors, but those can carry
  // client-controlled namespaces or tenant metadata. This BFF only exposes
  // the bounded page-size control needed by checkpoint lookup.
  if (!hasOnly(body, ["limit"])) {
    throw new AppError("Invalid history fields", 400, true, "INVALID_BODY_FIELDS");
  }
  const limit = body.limit === undefined ? 10 : body.limit;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new AppError("Invalid pagination", 400, true, "INVALID_PAGINATION");
  }
  return { limit: Number(limit) };
}

function normalizeCheckpointId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError("Invalid checkpoint", 400, true, "INVALID_CHECKPOINT");
  }
  const checkpointId = value.trim();
  if (!checkpointId || checkpointId.length > 256) {
    throw new AppError("Invalid checkpoint", 400, true, "INVALID_CHECKPOINT");
  }
  return checkpointId;
}

function normalizeBody(
  endpoint: GatewayEndpoint,
  body: unknown,
  scope: { userId: number; profileId: number; workspaceId: number },
): PlainRecord | undefined {
  if (!["create", "search", "update", "history", "run"].includes(endpoint)) {
    if (body !== undefined && endpoint !== "read" && endpoint !== "state" && endpoint !== "delete" && endpoint !== "cancel") {
      throw new AppError("Invalid request body", 400, true, "INVALID_BODY");
    }
    return undefined;
  }
  if (endpoint === "history") return normalizeHistoryBody(body);

  if (!isPlainRecord(body)) {
    throw new AppError("Invalid request body", 400, true, "INVALID_BODY");
  }

  if (endpoint === "search") {
    if (!hasOnly(body, ["limit", "offset", "status", "sort_by", "sort_order", "select"])) {
      throw new AppError("Invalid search fields", 400, true, "INVALID_BODY_FIELDS");
    }
    if (body.limit !== undefined && (!Number.isInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 100)) {
      throw new AppError("Invalid pagination", 400, true, "INVALID_PAGINATION");
    }
    if (body.offset !== undefined && (!Number.isInteger(body.offset) || Number(body.offset) < 0)) {
      throw new AppError("Invalid pagination", 400, true, "INVALID_PAGINATION");
    }
    return body;
  }

  if (endpoint === "create") {
    if (!hasOnly(body, ["metadata", "input"])) {
      throw new AppError("Invalid thread fields", 400, true, "INVALID_BODY_FIELDS");
    }
    if (body.input !== undefined && (!isPlainRecord(body.input) || !hasOnly(body.input, ["messages"]) ||
        !Array.isArray(body.input.messages) || body.input.messages.length !== 0)) {
      throw new AppError("New threads cannot contain messages", 400, true, "INVALID_THREAD_INPUT");
    }
    const title = clientTitle(body.metadata);
    return {
      metadata: { workspace_id: scope.workspaceId, ...(title ? { title } : {}) },
      input: {
        user_id: scope.userId,
        business_profile_id: scope.profileId,
        workspace_id: scope.workspaceId,
        channel: "internal_copilot",
      },
    };
  }

  if (endpoint === "update") {
    if (!hasOnly(body, ["metadata"])) {
      throw new AppError("Invalid thread fields", 400, true, "INVALID_BODY_FIELDS");
    }
    const title = clientTitle(body.metadata);
    return { metadata: { workspace_id: scope.workspaceId, ...(title ? { title } : {}) } };
  }

  if (!hasOnly(body, [
    "assistant_id", "input", "command", "stream_mode", "multitask_strategy", "on_disconnect",
    // An empty SDK config is harmless and preserves client compatibility;
    // any client-supplied config state is rejected below. checkpoint_id is
    // the scalar fork target that the SDK sends on the wire.
    "config", "checkpoint_id",
  ])) {
    throw new AppError("Invalid run fields", 400, true, "INVALID_BODY_FIELDS");
  }
  if (body.assistant_id !== ASSISTANT_GRAPH) {
    throw new AppError("Requested graph is not available", 403, true, "GRAPH_NOT_ALLOWED");
  }
  if (body.stream_mode !== undefined &&
      (!Array.isArray(body.stream_mode) ||
        !body.stream_mode.every((mode) => ["messages", "updates", "custom"].includes(String(mode))))) {
    throw new AppError("Invalid stream mode", 400, true, "INVALID_STREAM_MODE");
  }
  if (body.on_disconnect !== undefined && body.on_disconnect !== "cancel") {
    throw new AppError("Invalid disconnect policy", 400, true, "INVALID_DISCONNECT_POLICY");
  }
  if (body.multitask_strategy !== undefined && body.multitask_strategy !== "reject") {
    throw new AppError("Only reject multitask strategy is supported", 400, true, "INVALID_MULTITASK_STRATEGY");
  }
  if (body.config !== undefined && (!isPlainRecord(body.config) || Object.keys(body.config).length !== 0)) {
    throw new AppError("Client run config is not allowed", 400, true, "INVALID_RUN_CONFIG");
  }
  if (body.command !== undefined) {
    if (body.checkpoint_id !== undefined) {
      throw new AppError("Resume commands cannot select a checkpoint", 400, true, "INVALID_RESUME");
    }
    if (body.input !== undefined && body.input !== null) {
      throw new AppError("Resume commands cannot include input", 400, true, "INVALID_RESUME");
    }
    if (!isPlainRecord(body.command) || !hasOnly(body.command, ["resume"]) || !approval(body.command.resume)) {
      throw new AppError("Invalid resume command", 400, true, "INVALID_RESUME");
    }
    return {
      assistant_id: ASSISTANT_GRAPH,
      command: body.command,
      stream_mode: body.stream_mode,
      on_disconnect: "cancel",
      multitask_strategy: "reject",
    };
  }
  if (!isPlainRecord(body.input) || !hasOnly(body.input, ["messages"]) ||
      !Array.isArray(body.input.messages) || body.input.messages.length !== 1) {
    throw new AppError("Exactly one human message is required", 400, true, "ONE_HUMAN_MESSAGE_REQUIRED");
  }
  const checkpointId = normalizeCheckpointId(body.checkpoint_id);
  return {
    assistant_id: ASSISTANT_GRAPH,
    input: {
      messages: [normalizeHumanMessage(body.input.messages[0], scope.userId)],
      user_id: scope.userId,
      business_profile_id: scope.profileId,
      workspace_id: scope.workspaceId,
      channel: "internal_copilot",
    },
    stream_mode: body.stream_mode,
    ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    on_disconnect: "cancel",
    multitask_strategy: "reject",
  };
}

function queryString(req: AuthRequest): string {
  const rawUrl = req.url ?? "";
  const index = rawUrl.indexOf("?");
  return index >= 0 ? rawUrl.slice(index) : "";
}

function validateQuery(endpoint: GatewayEndpoint, req: AuthRequest): void {
  const keys = Object.keys(req.query ?? {});
  const allowed = endpoint === "state"
    ? ["subgraphs"]
    : endpoint === "cancel"
      ? ["wait", "action"]
      : [];
  if (keys.some((key) => !allowed.includes(key))) {
    throw new AppError("Invalid query parameters", 400, true, "INVALID_QUERY");
  }
  if (endpoint === "state" && req.query.subgraphs !== undefined &&
      !["0", "1", "true", "false"].includes(String(req.query.subgraphs))) {
    throw new AppError("Invalid state query", 400, true, "INVALID_QUERY");
  }
  if (endpoint === "cancel" && req.query.action !== undefined && req.query.action !== "interrupt") {
    throw new AppError("Invalid cancel action", 400, true, "INVALID_CANCEL_ACTION");
  }
}

function copyResponseHeaders(upstream: globalThis.Response, res: Response): void {
  for (const name of ["content-type", "cache-control", "transfer-encoding"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

/**
 * Authenticated, allow-listed proxy for the official LangGraph REST contract.
 * Both the web and native assistant-ui clients use this route; only this
 * gateway knows the agent-service URL/key and trusted tenant identity.
 */
export async function assistantGateway(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) throw new AppError("Authentication required", 401, true, "AUTH_REQUIRED");

  const endpoint = endpointFor(req.path.replace(/^\/+/, "").split("/"), req.method);
  if (!endpoint) {
    throw new AppError("Assistant operation is not allowed", 403, true, "OPERATION_NOT_ALLOWED");
  }
  validateQuery(endpoint, req);

  const requestedWorkspace = req.headers["x-workspace-id"];
  const headerWorkspaceId = typeof requestedWorkspace === "string" && requestedWorkspace.trim()
    ? Number(requestedWorkspace)
    : undefined;
  const cookieWorkspaceId = req.cookies?.wkil_ws ? Number(req.cookies.wkil_ws) : undefined;
  const workspaceId = headerWorkspaceId ?? (
    Number.isInteger(cookieWorkspaceId) && cookieWorkspaceId! > 0 ? cookieWorkspaceId : undefined
  );
  if (workspaceId !== undefined && (!Number.isInteger(workspaceId) || workspaceId <= 0)) {
    throw new AppError("Invalid workspace", 400, true, "INVALID_WORKSPACE_ID");
  }
  const profileId = await getActiveProfileId(userId, undefined, workspaceId);
  const access = await requireWorkspaceProfileAccess(userId, profileId);
  const resolvedWorkspaceId = access.workspaceId;
  const normalized = normalizeBody(endpoint, req.body, {
    userId,
    profileId,
    workspaceId: resolvedWorkspaceId,
  });
  const apiUrl = (process.env.LANGGRAPH_API_URL ?? "http://localhost:8123").replace(/\/+$/, "");
  const pathParts = req.path.replace(/^\/+/, "").split("/");
  const target = `${apiUrl}/${req.path.replace(/^\/+/, "")}${queryString(req)}`;
  // Interactive user traffic must use the BFF-scoped key. The monolith key
  // intentionally represents an unrestricted service caller and remains
  // reserved for internal background capability jobs in AgentClient.
  const apiKey = process.env.LANGGRAPH_API_KEY;
  if (!apiKey) throw new AppError("Agent service is not configured", 503, true, "AGENT_SERVICE_NOT_CONFIGURED");

  const headers = new Headers({
    accept: req.headers.accept ?? "*/*",
    "x-api-key": apiKey,
    "x-user-id": String(userId),
    "x-workspace-id": String(resolvedWorkspaceId),
    "x-business-profile-id": String(profileId),
  });
  if (normalized !== undefined) headers.set("content-type", "application/json");
  const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : crypto.randomUUID();
  headers.set("x-request-id", requestId);
  const locale = typeof req.headers["x-locale"] === "string" ? req.headers["x-locale"].toLowerCase() : "";
  if (locale === "ar" || locale === "en") headers.set("x-locale", locale);
  const acceptLanguage = typeof req.headers["accept-language"] === "string"
    ? req.headers["accept-language"].split(",")[0]?.trim().toLowerCase()
    : "";
  if (acceptLanguage === "ar" || acceptLanguage === "en") headers.set("accept-language", acceptLanguage);
  res.setHeader("X-Request-ID", requestId);

  const controller = new AbortController();
  let responseFinished = false;
  req.once("aborted", () => controller.abort());
  res.once("finish", () => { responseFinished = true; });
  res.once("close", () => {
    if (!responseFinished) controller.abort();
  });

  if (endpoint === "run") {
    const title = automaticTitleFromRun(normalized);
    const threadId = pathParts[1];
    if (title && threadId) {
      await ensureThreadTitle({
        apiUrl,
        threadId,
        title,
        headers,
        signal: controller.signal,
      });
    }
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: normalized === undefined ? undefined : JSON.stringify(normalized),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    logger.error("assistant.gateway.upstream_failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AppError("Assistant service is temporarily unavailable", 502, true, "AGENT_SVC_UNREACHABLE");
  }

  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  if (!upstream.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  Readable.fromWeb(upstream.body as unknown as ReadableStream<Uint8Array>).pipe(res);
}

export const assistantGatewayInternals = {
  endpointFor,
  normalizeBody,
  textFromMessageContent,
  deterministicThreadTitle,
  automaticTitleFromRun,
  ensureThreadTitle,
};
