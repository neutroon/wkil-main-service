import prisma from "@config/prisma";
import type { CanonicalOrder } from "./orderConfirmation.types";
import { renderOrderTemplateField } from "./orderConfirmation.fields";
import { getBodyMappingEntries, validateOrderTemplateMapping, orderTemplateUsesActions, type OrderTemplateMapping } from "./orderConfirmation.template-mapping";
export { validateOrderTemplateMapping, orderTemplateUsesActions } from "./orderConfirmation.template-mapping";
export type { OrderTemplateMapping } from "./orderConfirmation.template-mapping";

export type OrderTemplateConfig = {
  id: number;
  businessProfileId: number;
  whatsappAccountId: number;
  eventType: string;
  locale: string;
  templateName: string;
  languageCode: string;
  templateVersion: number;
  isActive: boolean;
  approvalStatus: string | null;
  variableMapping: OrderTemplateMapping;
};

export type RenderedOrderTemplateVariables = {
  body: string[];
  buttons?: {
    confirm: string;
    cancel: string;
  };
  previewText: string;
};

export async function resolveActiveTemplateConfig(params: {
  integrationId: number;
  businessProfileId?: number;
  whatsappAccountId: number;
  locale: string;
  eventType: string;
}): Promise<OrderTemplateConfig> {
  const config = await prisma.orderTemplateConfig.findFirst({
    where: {
      ...(params.businessProfileId === undefined
        ? {}
        : { businessProfileId: params.businessProfileId }),
      whatsappAccountId: params.whatsappAccountId,
      eventType: params.eventType,
      locale: params.locale,
      isActive: true,
      approvalStatus: "APPROVED",
      whatsappAccount: {
        orderIntegrations: {
          some: {
            id: params.integrationId,
            ...(params.businessProfileId === undefined
              ? {}
              : { businessProfileId: params.businessProfileId }),
          },
        },
      },
    },
    select: {
      id: true,
      businessProfileId: true,
      whatsappAccountId: true,
      eventType: true,
      locale: true,
      templateName: true,
      languageCode: true,
      templateVersion: true,
      isActive: true,
      approvalStatus: true,
      variableMapping: true,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });

  if (!config) {
    throw new Error("No active WhatsApp order template is configured");
  }

  if (
    params.businessProfileId !== undefined &&
    config.businessProfileId !== params.businessProfileId
  ) {
    throw new Error("WhatsApp order template belongs to another business profile");
  }

  if (config.approvalStatus && config.approvalStatus !== "APPROVED") {
    throw new Error("Configured WhatsApp order template is not approved");
  }

  const variableMapping = validateOrderTemplateMapping(config.variableMapping);

  return { ...config, variableMapping };
}

export function renderOrderTemplateVariables(
  order: CanonicalOrder | Record<string, unknown>,
  mapping: OrderTemplateMapping | unknown,
  actionTokens?: { confirm: string; cancel: string },
  selectedLocale?: string,
): RenderedOrderTemplateVariables {
  const normalizedMapping = validateOrderTemplateMapping(mapping);

  const body = getBodyMappingEntries(normalizedMapping).map(({ field }) =>
    renderOrderTemplateField(order, field, selectedLocale ?? String((order as Record<string, unknown>).locale ?? "en")).text,
  );
  const rendered: RenderedOrderTemplateVariables = {
    body,
    previewText: body.filter(Boolean).join(" | "),
  };

  if (actionTokens && orderTemplateUsesActions(normalizedMapping)) {
    rendered.buttons = actionTokens;
  }

  return rendered;
}
