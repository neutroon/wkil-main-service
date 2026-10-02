import { AppError } from "@middlewares/errorHandler.middleware";

// Meta error-code reference reviewed 2026-10-02. Definite rejection only;
// transport/JSON failures remain ambiguous and are handled by the caller.
const transientCodes = new Set([2, 130429, 131000, 131016]);
const permanentCodes = new Set([0, 3, 10, 100, 190, 368, 130497, 131005, 131008, 131009, 131026, 131030, 131047, 131048, 132000, 132001, 132005, 132007, 132012, 132015, 132016]);
export class WhatsAppTemplateRejectedError extends AppError {
  readonly providerCode?: number;
  readonly retryable: boolean;
  constructor(readonly httpStatus: number, response: unknown) {
    const code = (response as { error?: { code?: unknown } } | null)?.error?.code;
    const providerCode = typeof code === "number" && Number.isInteger(code) ? code : undefined;
    super(`WhatsApp template rejected${providerCode === undefined ? "" : ` (code ${providerCode})`}`, 502, true, "WHATSAPP_TEMPLATE_REJECTED");
    this.providerCode = providerCode;
    this.retryable = providerCode !== undefined && permanentCodes.has(providerCode) ? false : (providerCode !== undefined && transientCodes.has(providerCode)) || [408, 429, 500, 502, 503, 504].includes(httpStatus);
  }
}
