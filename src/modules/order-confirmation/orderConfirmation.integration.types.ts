import type { CanonicalOrder, OrderTemplateField } from "./orderConfirmation.types";
import type { OrderTemplateMapping } from "./orderConfirmation.template-mapping";

export type TemplateOrderInput = CanonicalOrder | Record<string, unknown>;
export type TemplateVariableRequirement = { component: "body"; placeholder: string; field: OrderTemplateField; paths: string[] };
export type TemplateVariableIssue = TemplateVariableRequirement & { reason: "missing" | "blank" | "invalid" };
export type TemplateFieldDescriptor = { id: OrderTemplateField; labels: { en: string; ar: string }; paths: string[]; requiredPaths: string[]; rule: "nonblank" | "any-item-name" | "any-item-quantity" | "money" | "street-address" };
export type TemplateVariablePresence = TemplateVariableRequirement & { present: boolean };
export type TemplateInspection = { body: string[]; previewText: string; variables: TemplateVariablePresence[]; errors: TemplateVariableIssue[] };
export type OrderTemplateContext = { integrationId: number; businessProfileId: number; whatsappAccountId: number | null; defaultLocale: "ar" | "en" };
export type IntegrationFailure = { code: string; message: string; retryable: boolean; errors: Array<TemplateVariableIssue | { paths: string[]; reason: string }> };
export type TemplateRequirements = { schemaVersion: "1"; supportedFields: TemplateFieldDescriptor[]; template: { id: number; name: string; languageCode: string; locale: "ar" | "en"; variableMapping: OrderTemplateMapping; variables: TemplateVariableRequirement[] } };
export type TemplateValidationData = { schemaVersion: "1"; schemaValid: true; templateReady: true; templateConfigId: number; templateName: string; languageCode: string; locale: "ar" | "en"; body: string[]; previewText: string; variables: TemplateVariablePresence[]; buttons?: { confirm: string; cancel: string } };
export type TemplateValidationResult = { status: 200; body: { data: TemplateValidationData } } | { status: 400 | 409 | 422; body: IntegrationFailure };
