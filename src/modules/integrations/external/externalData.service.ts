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
};

export type ExternalDataSourceStatusMetadata = {
  id: number;
  name: string;
  description: string;
};

export async function getExternalDataSourceStatusMetadata(
  businessProfileId: number,
  sourceId: number,
): Promise<ExternalDataSourceStatusMetadata | null> {
  return prisma.externalDataSource.findFirst({
    where: { id: sourceId, businessProfileId, isActive: true },
    select: { id: true, name: true, description: true },
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

export function serializeExternalDataSource<T extends { headers?: unknown }>(
  source: T,
): Omit<T, "headers"> & { headers?: Record<string, string> } {
  return {
    ...source,
    headers: maskExternalHeaders(source.headers),
  };
}

export function filterExternalArgsBySchema(
  expectedParamsSchema: unknown,
  args: Record<string, any>,
): Record<string, any> {
  if (!isRecord(expectedParamsSchema)) return {};

  const allowedKeys = new Set(
    Object.entries(expectedParamsSchema)
      .filter(([, value]) => isAiWritableFieldRule(value))
      .map(([key]) => key),
  );
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => allowedKeys.has(key)),
  );
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
    const source = getFieldSource(rule);

    if (source === "DEFAULT") {
      if (
        Object.prototype.hasOwnProperty.call(rule, "value") &&
        isMissingParamValue(existingParams[field])
      ) {
        params[field] = rule.value;
      }
    }

    if (source === "FIXED") {
      if (Object.prototype.hasOwnProperty.call(rule, "value")) {
        params[field] = rule.value;
      }
    }

    if (source === "CHAT_CONTEXT") {
      const contextValue = getContextValue(context, rule.contextKey);
      if (contextValue !== undefined && contextValue !== null && contextValue !== "") {
        params[field] = contextValue;
      }
    }
  }

  return params;
}

function isMissingParamValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
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
  const source = await prisma.externalDataSource.findFirst({
    where: { id: sourceId, businessProfileId, isActive: true },
  });

  if (!source) {
    throw new AppError(`Active data source with id ${sourceId} not found`, 404);
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
      const allParams = {
        ...filteredArgs,
        ...injectedParams,
        ...configuredParams,
      };
      for (const [key, val] of Object.entries(allParams)) {
        if (val !== undefined && val !== null) {
          url.searchParams.set(key, String(val));
        }
      }
      finalUrl = url.toString();
    } else {
      options.body = JSON.stringify({
        ...filteredArgs,
        ...injectedParams,
        ...configuredParams,
      });
    }

    const fetchResult = await fetchExternalWithRetry(finalUrl, options);
    const response = fetchResult.response;
    finalUrl = fetchResult.finalUrl;

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
          data: null,
          error: `External API returned status ${response.status}`,
        };
    }

    const contentType = response.headers.get("content-type") || "";
    const actionType = String((source as any).actionType || "LOOKUP").toUpperCase();
    const requiresJsonResponse = actionType !== "MUTATION";
    if (
      requiresJsonResponse &&
      !contentType.toLowerCase().includes("application/json")
    ) {
      return {
        success: false,
        verification: "failed",
        actionType: `integration_action_${sourceId}`,
        reason: "invalid_content_type",
        data: null,
        error: "External API did not return JSON",
      };
    }

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

    let data: unknown = null;
    if (body.trim()) {
      if (!contentType.toLowerCase().includes("application/json")) {
        data = body;
      } else {
        data = JSON.parse(body);
      }
    }
    const canonical =
      actionType === "MUTATION"
        ? toCanonicalVerificationMutation(data, response.ok)
        : toCanonicalVerificationRead(data);
    return {
      success: canonical.verification !== "failed",
      verification: canonical.verification,
      actionType: `integration_action_${sourceId}`,
      reason: canonical.reason,
      data,
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



