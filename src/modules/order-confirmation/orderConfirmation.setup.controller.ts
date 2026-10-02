import type { Request, Response } from "express";
import { z } from "zod";
import { authenticateOrderSetupRequest, OrderSetupHttpError, setupError } from "./orderConfirmation.setup-auth";
import { acquireOrderSetupPermit } from "./orderConfirmation.setup-rateLimit";
import { getOrderTemplateRequirements, OrderTemplateConfigurationError, validateOrderEventForTemplate } from "./orderConfirmation.template-validation.service";

const requirementsInput = z.object({ schemaVersion: z.literal("1"), locale: z.enum(["ar", "en"]).optional() }).strict();
async function runSetup(req: Request, res: Response, operation: "requirements" | "validate"): Promise<void> {
  try {
    const context = await authenticateOrderSetupRequest(req);
    const retryMs = await acquireOrderSetupPermit(context.integrationId);
    if (retryMs !== null) {
      res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
      throw setupError(429, "SETUP_RATE_LIMIT", "Setup request limit reached", true);
    }
    let body: unknown;
    try { body = JSON.parse(req.body.toString("utf8")); } catch { throw setupError(400, "INVALID_JSON", "Malformed JSON body"); }
    if (operation === "requirements") {
      const parsed = requirementsInput.safeParse(body);
      if (!parsed.success) throw setupError(400, "INVALID_REQUEST", "Requirements input must specify schemaVersion 1 and an optional ar/en locale");
      res.json({ data: await getOrderTemplateRequirements(context, parsed.data.locale) });
    } else {
      const eventId = body && typeof body === "object" ? (body as { eventId?: unknown }).eventId : undefined;
      if (typeof eventId !== "string" || !eventId || req.headers["idempotency-key"] !== eventId) throw setupError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must match eventId");
      const result = await validateOrderEventForTemplate(body, context);
      res.status(result.status).json(result.body);
    }
  } catch (error) {
    if (error instanceof OrderSetupHttpError) { res.status(error.status).json(error.failure); return; }
    if (error instanceof OrderTemplateConfigurationError) { res.status(409).json({ code: error.code, message: error.message, retryable: false, errors: [] }); return; }
    res.status(503).json({ code: "SETUP_UNAVAILABLE", message: "Setup validation is temporarily unavailable", retryable: true, errors: [] });
  }
}
export async function getSignedOrderRequirements(req: Request, res: Response): Promise<void> { await runSetup(req, res, "requirements"); }
export async function validateSignedOrderEvent(req: Request, res: Response): Promise<void> { await runSetup(req, res, "validate"); }
