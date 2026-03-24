import axios from "axios";

/** Normalize Axios / Graph API errors for clients and logs. */
export function mapFacebookGraphError(error: unknown): {
  message: string;
  code?: number | string;
  status?: number;
} {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: { message?: string; code?: number; type?: string } }
      | undefined;
    const fb = data?.error;
    if (fb) {
      return {
        message: fb.message || "Facebook Graph API error",
        code: fb.code,
        status: error.response?.status,
      };
    }
    return { message: error.message, status: error.response?.status };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}
