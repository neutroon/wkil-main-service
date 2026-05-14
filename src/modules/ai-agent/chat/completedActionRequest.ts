const COMPLETED_ACTION_REQUEST_PREFIX =
  "The queued external action for the customer's request has completed. Original customer request:";

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
