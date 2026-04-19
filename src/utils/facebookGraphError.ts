import axios from "axios";

/** Normalize Axios / Graph API errors for clients and logs. */
/** Normalize Axios / Graph API errors for clients and logs. */
export function mapFacebookGraphError(error: unknown): {
  message: string;
  code?: number | string;
  status?: number;
  isRetryable: boolean;
  subcode?: number;
} {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: { message?: string; code?: number; type?: string; error_subcode?: number } }
      | undefined;
    const fb = data?.error;
    const code = fb?.code || 0;
    const subcode = fb?.error_subcode;
    const status = error.response?.status || 500;

    // ELITE TIER: Smart Retry Categorization
    // Common retryable codes: 1 (API Unknown), 2 (API Service), 4 (API Too Many Calls), 17 (User Rate Limit)
    const isRetryable = [1, 2, 4, 17].includes(Number(code));

    let message = fb?.message || error.message || "Facebook Graph API error";
    
    // Explicit Mapping for clarity
    if (code === 100) {
      message = "The object no longer exists or permissions are missing (ID Scoping check recommended).";
    } else if (code === 17) {
      message = "Meta Rate Limit reached. Please slow down.";
    } else if (code === 368) {
      message = "Action temporarily blocked by Facebook (Spam protection).";
    }

    if (fb) {
      return {
        message,
        code,
        status,
        isRetryable,
        subcode,
      };
    }
    return { message, status, isRetryable: false };
  }
  if (error instanceof Error) return { message: error.message, isRetryable: false };
  return { message: String(error), isRetryable: false };
}
