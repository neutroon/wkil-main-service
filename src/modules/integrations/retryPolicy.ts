const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_NETWORK_MARKERS = [
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "CERT_",
  "SELF_SIGNED",
];
const RETRYABLE_NETWORK_MARKERS = [
  "AbortError",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "fetch failed",
];

export type RetryDecision = {
  retryable: boolean;
  reason: string;
};

export function classifyHttpRetry(status: number): RetryDecision {
  if (RETRYABLE_HTTP_STATUSES.has(status)) {
    return { retryable: true, reason: `retryable_http_${status}` };
  }
  return { retryable: false, reason: `non_retryable_http_${status}` };
}

export function classifyNetworkRetry(error: unknown): RetryDecision {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const combined = `${name} ${message}`;

  if (NON_RETRYABLE_NETWORK_MARKERS.some((marker) => combined.includes(marker))) {
    return { retryable: false, reason: "non_retryable_network_error" };
  }

  if (RETRYABLE_NETWORK_MARKERS.some((marker) => combined.includes(marker))) {
    return { retryable: true, reason: "retryable_network_error" };
  }

  return { retryable: false, reason: "unknown_network_error" };
}

export function backoffDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 1_000);
}

export async function waitForRetry(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
