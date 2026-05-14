import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";
import { decryptFacebookSecret, encryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import {
  backoffDelayMs,
  classifyHttpRetry,
  classifyNetworkRetry,
  waitForRetry,
} from "@modules/integrations/retryPolicy";
import dns from "dns/promises";
import net from "net";
import type { AgentActionTrigger, AgentActionType } from "@prisma/client";

type CanonicalVerification = "verified" | "unverified" | "failed";
const MASKED_SECRET = "********";
const MAX_EXTERNAL_RESPONSE_BYTES = 1_000_000;
const MAX_EXTERNAL_REDIRECTS = 3;
const MAX_EXTERNAL_FETCH_ATTEMPTS = 2;
const EXTERNAL_FETCH_TIMEOUT_MS = 8_000;
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

type ExternalQueryEnvelope = {
  success: boolean;
  verification: CanonicalVerification;
  actionType: string;
  reason: string;
  data: unknown;
  error?: string;
};

type ExternalToolContext = {
  customerPhone?: string;
  conversationId?: number;
  latestUserText?: string;
  historyText?: string;
  parentActionResponse?: unknown;
  workflowInputBindings?: unknown;
};

export type AgentActionSourceStatusMetadata = {
  id: number;
  businessProfileId: number;
  name: string;
  description: string;
  trigger: AgentActionTrigger;
  actionType: AgentActionType;
  isActive: boolean;
  expectedParamsSchema: unknown;
};

export async function getAgentActionSourceStatusMetadata(
  businessProfileId: number,
  sourceId: number,
): Promise<AgentActionSourceStatusMetadata | null> {
  return prisma.agentActionSource.findFirst({
    where: { id: sourceId, businessProfileId, isActive: true },
    select: {
      id: true,
      businessProfileId: true,
      name: true,
      description: true,
      trigger: true,
      actionType: true,
      isActive: true,
      expectedParamsSchema: true,
    },
  });
}

function looksEmptyResult(data: unknown): boolean {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") {
    return Object.keys(data as Record<string, unknown>).length === 0;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainHeaderMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isBlockedIp(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  return false;
}

export function assertExternalApiUrlLooksSafe(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError("Invalid external API URL", 400);
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new AppError("External API URL must use HTTP or HTTPS", 400);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new AppError("External API URL host is not allowed", 400);
  }

  if (net.isIP(hostname) && isBlockedIp(hostname)) {
    throw new AppError("External API URL IP range is not allowed", 400);
  }
}

export async function assertExternalApiUrlNetworkSafe(rawUrl: string): Promise<void> {
  assertExternalApiUrlLooksSafe(rawUrl);
  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname;

  if (net.isIP(hostname)) return;

  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new AppError("External API URL host could not be resolved", 400);
  }

  if (addresses.some((addr) => isBlockedIp(addr.address))) {
    throw new AppError("External API URL resolves to a private or reserved IP", 400);
  }
}

export function encryptExternalHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, encryptFacebookSecret(value)]),
  );
}

export function decryptExternalHeaders(headers: unknown): Record<string, string> {
  if (!isPlainHeaderMap(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, decryptFacebookSecret(value)]),
  );
}

export function maskExternalHeaders(headers: unknown): Record<string, string> | undefined {
  if (!isPlainHeaderMap(headers)) return undefined;
  return Object.fromEntries(Object.keys(headers).map((key) => [key, MASKED_SECRET]));
}

export function mergeHeaderUpdate(
  existingHeaders: unknown,
  incomingHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (incomingHeaders === undefined) return undefined;

  const existing = isPlainHeaderMap(existingHeaders) ? existingHeaders : {};
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (value === MASKED_SECRET && existing[key]) {
      merged[key] = existing[key];
    } else {
      merged[key] = encryptFacebookSecret(value);
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function serializeAgentActionSource<
  T extends {
    headers?: unknown;
    routingEmbedding?: unknown;
    routingTextHash?: unknown;
    routingIndexedAt?: unknown;
  },
>(
  source: T,
): Omit<T, "headers" | "routingEmbedding" | "routingTextHash" | "routingIndexedAt"> & {
  headers?: Record<string, string>;
} {
  const {
    headers,
    routingEmbedding: _routingEmbedding,
    routingTextHash: _routingTextHash,
    routingIndexedAt: _routingIndexedAt,
    ...publicSource
  } = source;

  return {
    ...publicSource,
    headers: maskExternalHeaders(headers),
  };
}

export function filterExternalArgsBySchema(
  expectedParamsSchema: unknown,
  args: Record<string, any>,
): Record<string, any> {
  if (!isRecord(expectedParamsSchema)) return {};

  const filtered: Record<string, any> = {};
  for (const [key, rule] of Object.entries(expectedParamsSchema)) {
    if (!isAiWritableFieldRule(rule)) continue;
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;

    const value = filterExternalArgValueByRule(rule, args[key]);
    if (!isMissingParamValue(value)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function filterExternalArgValueByRule(rule: unknown, value: unknown): unknown {
  if (!isRecord(rule)) return value;

  const type = String(rule.type || "STRING").toUpperCase();
  if (type === "OBJECT" && isRecord(rule.properties) && isRecord(value)) {
    const filtered: Record<string, any> = {};
    for (const [childKey, childRule] of Object.entries(rule.properties)) {
      if (!isAiWritableFieldRule(childRule)) continue;
      if (!Object.prototype.hasOwnProperty.call(value, childKey)) continue;

      const childValue = filterExternalArgValueByRule(
        childRule,
        (value as Record<string, unknown>)[childKey],
      );
      if (!isMissingParamValue(childValue)) {
        filtered[childKey] = childValue;
      }
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  }

  if (type === "ARRAY" && Array.isArray(value) && isRecord(rule.items)) {
    const filteredItems = value
      .map((item) => filterExternalArgValueByRule(rule.items, item))
      .filter((item) => !isMissingParamValue(item));
    return filteredItems.length > 0 ? filteredItems : undefined;
  }

  return value;
}

function getFieldSource(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "USER_PROVIDED";
  }
  const rule = value as Record<string, unknown>;
  if (String(rule.type ?? "").toUpperCase() === "FIXED") return "FIXED";
  return String(rule.source ?? "USER_PROVIDED").toUpperCase();
}

function isAiWritableFieldRule(value: unknown): boolean {
  const source = getFieldSource(value);
  return source === "USER_PROVIDED" || source === "AI_DERIVED";
}

function isFixedFieldRule(value: unknown): boolean {
  return getFieldSource(value) === "FIXED";
}

function getContextValue(context: ExternalToolContext, contextKey: unknown): unknown {
  if (contextKey === "customerPhone") return context.customerPhone;
  if (contextKey === "conversationId") return context.conversationId;
  return undefined;
}

export function assertExternalArgsAllowedByPolicy(
  schema: unknown,
  args: Record<string, any>,
  context: ExternalToolContext,
): { ok: true } | { ok: false; reason: string; field: string } {
  if (!isRecord(schema)) return { ok: true };
  const userText = `${context.historyText || ""} ${context.latestUserText || ""}`.toLowerCase();

  for (const [field, rule] of Object.entries(schema)) {
    if (!isRecord(rule) || !isAiWritableFieldRule(rule)) continue;
    if (!Object.prototype.hasOwnProperty.call(args, field)) continue;

    const source = getFieldSource(rule);
    if (source === "AI_DERIVED") continue;

    for (const value of flattenScalarValues(args[field])) {
      const normalized = value.toLowerCase().trim();
      if (normalized.length < 2) continue;
      if (!valueAppearsInUserText(normalized, userText)) {
        return {
          ok: false,
          field,
          reason: `unprovided_parameter:${field}`,
        };
      }
    }
  }

  return { ok: true };
}

function valueAppearsInUserText(value: string, userText: string): boolean {
  if (userText.includes(value)) return true;

  const compactValue = compactForMatching(value);
  if (compactValue.length < 2) return true;
  return compactForMatching(userText).includes(compactValue);
}

function compactForMatching(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/gi, "");
}

export function buildServerInjectedParams(
  schema: unknown,
  context: ExternalToolContext,
  existingParams: Record<string, any> = {},
): Record<string, any> {
  if (!isRecord(schema)) return {};

  const params: Record<string, any> = {};
  for (const [field, rule] of Object.entries(schema)) {
    if (!isRecord(rule)) continue;
    const injectedValue = buildServerInjectedValueByRule(
      rule,
      context,
      existingParams[field],
    );
    if (!isMissingParamValue(injectedValue)) {
      params[field] = injectedValue;
    }
  }

  return params;
}

function buildServerInjectedValueByRule(
  rule: Record<string, unknown>,
  context: ExternalToolContext,
  existingValue: unknown,
): unknown {
  const source = getFieldSource(rule);

  if (source === "DEFAULT") {
    if (
      Object.prototype.hasOwnProperty.call(rule, "value") &&
      isMissingParamValue(existingValue)
    ) {
      return rule.value;
    }
    return undefined;
  }

  if (source === "FIXED") {
    return Object.prototype.hasOwnProperty.call(rule, "value")
      ? rule.value
      : undefined;
  }

  if (source === "CHAT_CONTEXT") {
    const contextValue = getContextValue(context, rule.contextKey);
    return isMissingParamValue(contextValue) ? undefined : contextValue;
  }

  if (source === "ACTION_RESULT") {
    const actionValue = getByPath(
      context.parentActionResponse,
      String(rule.path || rule.resultPath || ""),
    );
    return isMissingParamValue(actionValue) ? undefined : actionValue;
  }

  const type = String(rule.type || "STRING").toUpperCase();
  if (type === "OBJECT" && isRecord(rule.properties)) {
    const injected: Record<string, any> = {};
    const existingObject = isRecord(existingValue) ? existingValue : {};
    for (const [childKey, childRule] of Object.entries(rule.properties)) {
      if (!isRecord(childRule)) continue;
      const childValue = buildServerInjectedValueByRule(
        childRule,
        context,
        existingObject[childKey],
      );
      if (!isMissingParamValue(childValue)) {
        injected[childKey] = childValue;
      }
    }
    return Object.keys(injected).length > 0 ? injected : undefined;
  }

  return undefined;
}

function buildWorkflowBoundParams(
  bindings: unknown,
  args: Record<string, any>,
  context: ExternalToolContext,
): Record<string, any> {
  if (!isRecord(bindings)) return {};
  const output: Record<string, any> = {};

  for (const [targetPath, binding] of Object.entries(bindings)) {
    if (!isRecord(binding)) continue;
    const source = String(binding.source || "USER_PROVIDED").toUpperCase();
    let value: unknown;

    if (source === "ACTION_RESULT") {
      value = getByPath(context.parentActionResponse, String(binding.path || ""));
    } else if (source === "CHAT_CONTEXT") {
      value = getByPath(context as unknown as Record<string, unknown>, String(binding.path || ""));
    } else if (source === "FIXED") {
      value = binding.value;
    } else if (source === "DEFAULT") {
      value = getByPath(args, targetPath);
      if (isMissingParamValue(value)) value = binding.default ?? binding.value;
    } else {
      value = getByPath(args, String(binding.path || targetPath));
    }

    if (!isMissingParamValue(value)) {
      setByPath(output, targetPath, value);
    }
  }

  return output;
}

function deepMergeRecords(
  base: Record<string, any>,
  update: Record<string, any>,
): Record<string, any> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(update)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMergeRecords(
        merged[key] as Record<string, any>,
        value as Record<string, any>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

type MappingContext = {
  args: Record<string, any>;
  context: ExternalToolContext;
  response?: unknown;
  responseMeta?: {
    ok: boolean;
    status: number;
    headers: Record<string, string>;
  };
};

function applyObjectMapping(
  mapping: unknown,
  context: MappingContext,
): Record<string, any> | null {
  if (!isRecord(mapping) || Object.keys(mapping).length === 0) return null;

  const output: Record<string, any> = {};
  for (const [targetPath, rule] of Object.entries(mapping)) {
    const value = resolveMappingRule(rule, context);
    if (value !== undefined) {
      setByPath(output, targetPath, value);
    }
  }
  return output;
}

function resolveMappingRule(rule: unknown, context: MappingContext): unknown {
  if (typeof rule === "string") {
    if (rule.includes("{{")) return interpolateTemplate(rule, context);
    if (rule.startsWith("$")) return resolveExpression(rule, context);
    return rule;
  }

  if (isRecord(rule)) {
    const from = rule.from ?? rule.path ?? rule.sourcePath;
    if (typeof from === "string") {
      const value = resolveExpression(from.startsWith("$") ? from : `$${from}`, context);
      if (isMissingParamValue(value) && Object.prototype.hasOwnProperty.call(rule, "default")) {
        return rule.default;
      }
      return value;
    }
    if (Object.prototype.hasOwnProperty.call(rule, "value")) {
      return rule.value;
    }
  }

  return rule;
}

function interpolateTemplate(template: string, context: MappingContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr) => {
    const value = resolveExpression(`$${String(expr).replace(/^\$/, "")}`, context);
    return value === undefined || value === null ? "" : String(value);
  });
}

function resolveExpression(expression: string, context: MappingContext): unknown {
  const normalized = expression.replace(/^\$/, "");
  if (normalized === "ok") return context.responseMeta?.ok;
  if (normalized === "status") return context.responseMeta?.status;
  if (normalized.startsWith("args.")) {
    return getByPath(context.args, normalized.slice("args.".length));
  }
  if (normalized.startsWith("context.")) {
    return getByPath(context.context as unknown as Record<string, unknown>, normalized.slice("context.".length));
  }
  if (normalized.startsWith("response.")) {
    return getByPath(context.response, normalized.slice("response.".length));
  }
  if (normalized === "response") return context.response;
  if (normalized.startsWith("headers.")) {
    return context.responseMeta?.headers[normalized.slice("headers.".length).toLowerCase()];
  }
  return undefined;
}

function getByPath(source: unknown, path: string): unknown {
  if (!path) return source;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === "object") {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, source);
}

function setByPath(target: Record<string, any>, path: string, value: unknown) {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return;
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, any>;
  }
  cursor[segments[segments.length - 1]] = value;
}

function isMissingParamValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function parseExternalResponseBody(body: string, contentType: string): unknown {
  if (!body.trim()) return null;
  if (!contentType.toLowerCase().includes("application/json")) return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function extractExternalErrorMessage(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;

  const candidates = [
    isRecord(data.error) && isRecord(data.error.details)
      ? firstStringInValue(data.error.details.errors)
      : undefined,
    isRecord(data.error) ? data.error.message : undefined,
    isRecord(data.error) ? firstStringInValue(data.error) : undefined,
    firstStringInValue(data.errors),
    data.message,
    data.error,
    data.detail,
    data.reason,
    isRecord(data.errors) ? data.errors.message : undefined,
  ];

  const value = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim(),
  );
  return typeof value === "string" ? value.slice(0, 500) : undefined;
}

function firstStringInValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = firstStringInValue(item);
      if (nested) return nested;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      const text = firstStringInValue(nested);
      if (text) return text;
    }
  }
  return undefined;
}

function flattenScalarValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenScalarValues);
  if (isRecord(value)) return Object.values(value).flatMap(flattenScalarValues);
  return [];
}

async function fetchOnceWithTimeout(
  url: string,
  options: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchExternalWithRetry(
  initialUrl: string,
  options: RequestInit,
): Promise<{ response: Response; finalUrl: string; attempts: number }> {
  let finalUrl = initialUrl;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_EXTERNAL_FETCH_ATTEMPTS; attempt++) {
    try {
      let response = await fetchOnceWithTimeout(finalUrl, options);

      for (
        let redirects = 0;
        redirects < MAX_EXTERNAL_REDIRECTS &&
        response.status >= 300 &&
        response.status < 400;
        redirects++
      ) {
        const location = response.headers.get("location");
        if (!location) break;
        const nextUrl = new URL(location, finalUrl).toString();
        await assertExternalApiUrlNetworkSafe(nextUrl);
        finalUrl = nextUrl;
        response = await fetchOnceWithTimeout(finalUrl, options);
      }

      const retryDecision = classifyHttpRetry(response.status);
      if (!response.ok && retryDecision.retryable && attempt < MAX_EXTERNAL_FETCH_ATTEMPTS) {
        logger.warn("external_api_retrying_http", {
          host: new URL(finalUrl).host,
          status: response.status,
          attempt,
        });
        await waitForRetry(backoffDelayMs(attempt));
        continue;
      }

      return { response, finalUrl, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryDecision = classifyNetworkRetry(error);
      if (retryDecision.retryable && attempt < MAX_EXTERNAL_FETCH_ATTEMPTS) {
        logger.warn("external_api_retrying_network", {
          host: new URL(finalUrl).host,
          reason: retryDecision.reason,
          attempt,
        });
        await waitForRetry(backoffDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * External data queries are read-only fetches. If the HTTP layer succeeded and the
 * body is non-empty JSON, that is sufficient "verification" for guardrails — we are
 * not asserting a write-side confirmation (order booked, etc.); the model must still
 * ground answers in this payload. Explicit provider error signals map to failed.
 */
/** Exported for unit tests; read-only external query semantics. */
export function toCanonicalVerificationRead(data: unknown): {
  verification: CanonicalVerification;
  reason: string;
} {
  if (looksEmptyResult(data)) {
    return { verification: "failed", reason: "no_data_found" };
  }
  if (isRecord(data)) {
    if (data.success === false) {
      return { verification: "failed", reason: "provider_success_false" };
    }
    const statusRaw = String(data.status ?? "").toLowerCase();
    if (["failed", "error", "cancelled", "canceled"].includes(statusRaw)) {
      return { verification: "failed", reason: `provider_status_${statusRaw}` };
    }
  }
  return { verification: "verified", reason: "data_returned" };
}

export function toCanonicalVerificationMutation(
  data: unknown,
  responseOk: boolean,
): {
  verification: CanonicalVerification;
  reason: string;
} {
  if (!responseOk) return { verification: "failed", reason: "http_failed" };
  if (data == null || data === "") {
    return { verification: "verified", reason: "http_success" };
  }
  if (isRecord(data)) {
    if (data.success === false) {
      return { verification: "failed", reason: "provider_success_false" };
    }
    const statusRaw = String(data.status ?? "").toLowerCase();
    if (["failed", "error", "cancelled", "canceled", "rejected"].includes(statusRaw)) {
      return { verification: "failed", reason: `provider_status_${statusRaw}` };
    }
    if (
      data.success === true ||
      ["ok", "success", "confirmed", "created", "updated", "completed"].includes(statusRaw)
    ) {
      return { verification: "verified", reason: "provider_confirmed" };
    }
  }
  return { verification: "verified", reason: "http_success" };
}

export async function executeExternalQuery(
  businessProfileId: number,
  sourceId: number,
  args: Record<string, any>,
  context: ExternalToolContext = {},
): Promise<ExternalQueryEnvelope> {
  const source = await prisma.agentActionSource.findFirst({
    where: { id: sourceId, businessProfileId, isActive: true },
  });

  if (!source) {
    throw new AppError(`Active Agent Action source with id ${sourceId} not found`, 404);
  }

  try {
    await assertExternalApiUrlNetworkSafe(source.apiUrl);
    const filteredArgs = filterExternalArgsBySchema(
      source.expectedParamsSchema,
      args,
    );
    const policyCheck = assertExternalArgsAllowedByPolicy(
      source.expectedParamsSchema,
      filteredArgs,
      context,
    );
    if (!policyCheck.ok) {
      return {
        success: false,
        verification: "failed",
        actionType: `integration_action_${sourceId}`,
        reason: policyCheck.reason,
        data: null,
        error: `External tool parameter "${policyCheck.field}" was not provided by an allowed source`,
      };
    }
    const configuredParams = (source.queryParams as object || {}) as Record<string, any>;
    const injectedParams = buildServerInjectedParams(
      source.expectedParamsSchema,
      context,
      { ...filteredArgs, ...configuredParams },
    );
    const baseParams = {
      ...filteredArgs,
      ...injectedParams,
      ...configuredParams,
    };
    const allParams = deepMergeRecords(
      baseParams,
      buildWorkflowBoundParams(context.workflowInputBindings, baseParams, context),
    );
    const mappedRequest = applyObjectMapping(source.requestMapping, {
      args: allParams,
      context,
    });
    let finalUrl = source.apiUrl;
    let options: RequestInit = {
      method: source.method,
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (source.headers) {
      options.headers = { ...options.headers, ...decryptExternalHeaders(source.headers) };
    }

    if (source.method === "GET") {
      const url = new URL(source.apiUrl);
      for (const [key, val] of Object.entries(mappedRequest ?? allParams)) {
        if (val !== undefined && val !== null) {
          url.searchParams.set(key, String(val));
        }
      }
      finalUrl = url.toString();
    } else {
      options.body = JSON.stringify(mappedRequest ?? allParams);
    }

    const fetchResult = await fetchExternalWithRetry(finalUrl, options);
    const response = fetchResult.response;
    finalUrl = fetchResult.finalUrl;

    const contentType = response.headers.get("content-type") || "";
    const actionType = String((source as any).actionType || "LOOKUP").toUpperCase();
    const requiresJsonResponse = actionType !== "MUTATION";
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_EXTERNAL_RESPONSE_BYTES) {
      return {
        success: false,
        verification: "failed",
        actionType: `integration_action_${sourceId}`,
        reason: "response_too_large",
        data: null,
        error: "External API response exceeded size limit",
      };
    }
    const parsedBody = parseExternalResponseBody(body, contentType);
    const mappedResponse = applyObjectMapping(source.responseMapping, {
      args: allParams,
      context,
      response: parsedBody,
      responseMeta: {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(
          Array.from(response.headers.entries()).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        ),
      },
    });
    const canonicalData = mappedResponse ?? parsedBody;

    if (!response.ok) {
      const retryDecision = classifyHttpRetry(response.status);
      logger.warn("external_api_failed", {
        host: new URL(finalUrl).host,
        status: response.status,
        attempts: fetchResult.attempts,
        retryable: retryDecision.retryable,
      });
      return {
        success: false,
        verification: "failed",
        actionType: `integration_action_${sourceId}`,
        reason: retryDecision.reason,
        data: canonicalData,
        error: extractExternalErrorMessage(canonicalData) || `External API returned status ${response.status}`,
      };
    }

    if (
      requiresJsonResponse &&
      !contentType.toLowerCase().includes("application/json")
    ) {
      return {
        success: false,
        verification: "failed",
        actionType: `integration_action_${sourceId}`,
        reason: "invalid_content_type",
        data: canonicalData,
        error: "External API did not return JSON",
      };
    }

    const canonical =
      actionType === "MUTATION"
        ? toCanonicalVerificationMutation(canonicalData, response.ok)
        : toCanonicalVerificationRead(canonicalData);
    return {
      success: canonical.verification !== "failed",
      verification: canonical.verification,
      actionType: `integration_action_${sourceId}`,
      reason: canonical.reason,
      data: canonicalData,
    };
  } catch (error: any) {
    logger.error("external_api_error", {
      sourceId,
      businessProfileId,
      errorMessage: String(error?.message || error),
    });
    return {
      success: false,
      verification: "failed",
      actionType: `integration_action_${sourceId}`,
      reason: "network_or_runtime_error",
      data: null,
      error: String(error),
    };
  }
}



