const COMPLETED_ACTION_REQUEST_PREFIX =
  "The queued external action for the customer's request has completed. Original customer request:";
const MAX_COMPLETED_ACTION_REQUEST_CHARS = 3_000;

export function extractOriginalRequestFromCompletedActionMessage(
  messageText: string,
): string | null {
  const trimmed = messageText.trim();
  if (!trimmed.startsWith(COMPLETED_ACTION_REQUEST_PREFIX)) return null;

  const originalRequest = trimmed.slice(COMPLETED_ACTION_REQUEST_PREFIX.length).trim();
  return originalRequest.length > 0 ? originalRequest : null;
}

export function effectiveCustomerRequestText(messageText: string): string {
  return extractOriginalRequestFromCompletedActionMessage(messageText) ?? messageText;
}

export function formatCompletedActionRequestMessage(originalRequest: string): string {
  return `${COMPLETED_ACTION_REQUEST_PREFIX} ${boundCompletedActionRequest(originalRequest)}`;
}

function boundCompletedActionRequest(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_COMPLETED_ACTION_REQUEST_CHARS) return trimmed;

  const headChars = 1_100;
  const tailChars = MAX_COMPLETED_ACTION_REQUEST_CHARS - headChars - 80;
  return [
    trimmed.slice(0, headChars).trimEnd(),
    "[middle of action request context omitted]",
    trimmed.slice(-tailChars).trimStart(),
  ].join("\n");
}
