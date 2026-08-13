import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  createIntegration,
  createTemplateConfig,
  getGlobalState,
  getOrder,
  listApprovedTemplates,
  listIntegrations,
  listOrders,
  listTemplateConfigs,
  retryNotification,
  retryStoreSync,
  rotateSecret,
  testEvent,
  updateGlobalState,
  updateIntegration,
  updateTemplateConfig,
} from "./orderConfirmation.controller";

const positiveId = z.coerce.number().int().positive();
const locale = z.enum(["ar", "en"]);
const orderStatus = z.enum(["AWAITING_CONFIRMATION", "CONFIRMED", "CANCELED"]);
const eventType = z.literal("order.created");

const emptyBody = z.object({}).strict().optional();
const idParams = z.object({ params: z.object({ id: positiveId }).strict() });

const integrationsListSchema = z.object({
  query: z.object({ businessProfileId: positiveId.optional() }).strict(),
});

const createIntegrationSchema = z.object({
  body: z
    .object({
      businessProfileId: positiveId,
      whatsappAccountId: positiveId.nullable().optional(),
      defaultLocale: locale.default("en"),
      isActive: z.boolean().default(false),
      storeSyncEnabled: z.boolean().default(false),
      statusCallbackUrl: z.string().optional().nullable(),
      statusCallbackSecret: z.string().optional().nullable(),
      callbackSecret: z.string().optional().nullable(),
      rotateStatusCallbackSecret: z.boolean().default(false),
      rotateCallbackSecret: z.boolean().default(false),
    })
    .strict(),
});

const updateIntegrationSchema = z.object({
  ...idParams.shape,
  body: z
    .object({
      whatsappAccountId: positiveId.nullable().optional(),
      defaultLocale: locale.optional(),
      isActive: z.boolean().optional(),
      storeSyncEnabled: z.boolean().optional(),
      statusCallbackUrl: z.string().optional().nullable(),
      statusCallbackSecret: z.string().optional().nullable(),
      callbackSecret: z.string().optional().nullable(),
      rotateStatusCallbackSecret: z.boolean().optional(),
      rotateCallbackSecret: z.boolean().optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "At least one integration field is required"),
});

const templateListSchema = z.object({
  query: z
    .object({
      whatsappAccountId: positiveId,
      businessProfileId: positiveId.optional(),
    })
    .strict(),
});

const templateConfigListSchema = z.object({
  query: z
    .object({
      integrationId: positiveId,
      businessProfileId: positiveId.optional(),
      whatsappAccountId: positiveId.optional(),
      eventType: eventType.optional(),
      locale: locale.optional(),
    })
    .strict(),
});

const createTemplateConfigSchema = z.object({
  body: z
    .object({
      integrationId: positiveId,
      businessProfileId: positiveId.optional(),
      whatsappAccountId: positiveId,
      eventType,
      locale,
      templateName: z.string().trim().min(1),
      languageCode: z.string().trim().min(1),
      templateVersion: positiveId.default(1),
      variableMapping: z.unknown().refine((value) => value !== undefined, "variableMapping is required"),
      isActive: z.boolean().default(true),
    })
    .strict(),
});

const updateTemplateConfigSchema = z.object({
  ...idParams.shape,
  body: z
    .object({
      integrationId: positiveId,
      whatsappAccountId: positiveId.optional(),
      locale: locale.optional(),
      templateName: z.string().trim().min(1).optional(),
      languageCode: z.string().trim().min(1).optional(),
      templateVersion: positiveId.optional(),
      variableMapping: z.unknown().optional(),
      isActive: z.boolean().optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "At least one template field is required"),
});

const testEventSchema = z.object({
  ...idParams.shape,
  body: z.record(z.string(), z.unknown()),
});

const ordersListSchema = z.object({
  query: z
    .object({
      page: z.string().optional().transform((value) => Math.max(1, Number.parseInt(value ?? "1", 10) || 1)),
      limit: z.string().optional().transform((value) => Math.min(100, Math.max(1, Number.parseInt(value ?? "20", 10) || 20))),
      businessProfileId: positiveId.optional(),
      integrationId: positiveId.optional(),
      status: orderStatus.optional(),
    })
    .strict(),
});

const globalStateSchema = z.object({
  body: z.object({ enabled: z.boolean() }).strict(),
});

const retrySchema = z.object({
  ...idParams.shape,
  body: emptyBody,
});

const orderConfirmationRoutes = Router();

orderConfirmationRoutes.get("/order-integrations", validate(integrationsListSchema), listIntegrations);
orderConfirmationRoutes.post("/order-integrations", validate(createIntegrationSchema), createIntegration);
orderConfirmationRoutes.patch(
  "/order-integrations/:id",
  validate(updateIntegrationSchema),
  updateIntegration,
);
orderConfirmationRoutes.post(
  "/order-integrations/:id/rotate-secret",
  validate(idParams),
  rotateSecret,
);
orderConfirmationRoutes.post(
  "/order-integrations/:id/test-event",
  validate(testEventSchema),
  testEvent,
);

orderConfirmationRoutes.get(
  "/order-confirmations/templates",
  validate(templateListSchema),
  listApprovedTemplates,
);
orderConfirmationRoutes.get(
  "/order-confirmations/template-configs",
  validate(templateConfigListSchema),
  listTemplateConfigs,
);
orderConfirmationRoutes.post(
  "/order-confirmations/template-configs",
  validate(createTemplateConfigSchema),
  createTemplateConfig,
);
orderConfirmationRoutes.patch(
  "/order-confirmations/template-configs/:id",
  validate(updateTemplateConfigSchema),
  updateTemplateConfig,
);
orderConfirmationRoutes.get(
  "/order-confirmations/orders",
  validate(ordersListSchema),
  listOrders,
);
orderConfirmationRoutes.get(
  "/order-confirmations/orders/:id",
  validate(idParams),
  getOrder,
);
orderConfirmationRoutes.post(
  "/order-confirmations/notifications/:id/retry",
  validate(retrySchema),
  retryNotification,
);
orderConfirmationRoutes.post(
  "/order-confirmations/sync/:id/retry",
  validate(retrySchema),
  retryStoreSync,
);

orderConfirmationRoutes.get(
  "/order-confirmations/global-state",
  requireAdmin,
  getGlobalState,
);
orderConfirmationRoutes.patch(
  "/order-confirmations/global-state",
  requireAdmin,
  validate(globalStateSchema),
  updateGlobalState,
);

export { orderConfirmationRoutes };
export default orderConfirmationRoutes;
