import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";

type CanonicalVerification = "verified" | "unverified" | "failed";

type ExternalQueryEnvelope = {
  success: boolean;
  verification: CanonicalVerification;
  actionType: string;
  reason: string;
  data: unknown;
  error?: string;
};

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

export async function executeExternalQuery(
  sourceId: number,
  args: Record<string, any>
): Promise<ExternalQueryEnvelope> {
  const source = await prisma.externalDataSource.findUnique({
    where: { id: sourceId },
  });

  if (!source) {
    throw new Error(`Data source with id ${sourceId} not found`);
  }

  try {
    let finalUrl = source.apiUrl;
    let options: RequestInit = {
      method: source.method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (source.headers) {
      options.headers = { ...options.headers, ...(source.headers as Record<string, string>) };
    }

    if (source.method === "GET") {
      const url = new URL(source.apiUrl);
      const allParams = { ...(source.queryParams as object || {}), ...args };
      for (const [key, val] of Object.entries(allParams)) {
        if (val !== undefined && val !== null) {
          url.searchParams.append(key, String(val));
        }
      }
      finalUrl = url.toString();
    } else {
      options.body = JSON.stringify({ ...(source.queryParams as object || {}), ...args });
    }

    // Set a strict timeout so AI doesn't hang forever. Better scalability setup.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 seconds limit
    options.signal = controller.signal;

    const response = await fetch(finalUrl, options);
    clearTimeout(timeoutId);

    if (!response.ok) {
        logger.warn("external_api_failed", { url: finalUrl, status: response.status });
        return {
          success: false,
          verification: "failed",
          actionType: `external_query_${sourceId}`,
          reason: "http_error",
          data: null,
          error: `External API returned status ${response.status}`,
        };
    }

    const data = await response.json();
    const canonical = toCanonicalVerificationRead(data);
    return {
      success: canonical.verification !== "failed",
      verification: canonical.verification,
      actionType: `external_query_${sourceId}`,
      reason: canonical.reason,
      data,
    };
  } catch (error: any) {
    logger.error("external_api_error", { errorMessage: String(error) });
    return {
      success: false,
      verification: "failed",
      actionType: `external_query_${sourceId}`,
      reason: "network_or_runtime_error",
      data: null,
      error: String(error),
    };
  }
}
