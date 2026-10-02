import { listOrderTemplateFields, renderOrderTemplateField } from "./orderConfirmation.fields";
import { getBodyMappingEntries, type OrderTemplateMapping } from "./orderConfirmation.template-mapping";
import type { TemplateInspection, TemplateOrderInput, TemplateVariableIssue } from "./orderConfirmation.integration.types";

/** Pure rendering and presence checks shared by preview, setup, and live sends. */
export function inspectOrderTemplateVariables(order: TemplateOrderInput, mapping: OrderTemplateMapping, locale: string): TemplateInspection {
  const fields = listOrderTemplateFields();
  const body: string[] = [], variables: TemplateInspection["variables"] = [], errors: TemplateVariableIssue[] = [];
  for (const entry of getBodyMappingEntries(mapping)) {
    const descriptor = fields.find(field => field.id === entry.field)!;
    const requirement = { component: "body" as const, ...entry, paths: descriptor.requiredPaths };
    const value = renderOrderTemplateField(order, entry.field, locale);
    body.push(value.text);
    variables.push({ ...requirement, present: !value.reason });
    if (value.reason) errors.push({ ...requirement, reason: value.reason });
  }
  return { body, previewText: body.filter(Boolean).join(" | "), variables, errors };
}
