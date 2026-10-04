// Meta IDs identify template records. Name/language lookup is only for legacy
// configurations; a missing pinned ID must never select a replacement record.
type MetaTemplate = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  language?: unknown;
  languageCode?: unknown;
  language_code?: unknown;
};

export type OrderTemplateIdentity = {
  metaTemplateId?: string | null;
  templateName: string;
  languageCode: string;
};

export function getMetaTemplateId(template: MetaTemplate): string | null {
  return typeof template.id === "string" && template.id.length > 0 ? template.id : null;
}

export function metaTemplateLanguage(template: MetaTemplate): string {
  const value = template.languageCode ?? template.language ?? template.language_code ?? "";
  return typeof value === "object" && value !== null
    ? String((value as { code?: unknown }).code ?? "") : String(value);
}

export function findApprovedWhatsAppTemplate<T extends MetaTemplate>(
  templates: readonly T[], identity: OrderTemplateIdentity,
): T | undefined {
  return templates.find(template => String(template.status ?? "").toUpperCase() === "APPROVED" && (
    identity.metaTemplateId != null
      ? getMetaTemplateId(template) === identity.metaTemplateId
      : template.name === identity.templateName && metaTemplateLanguage(template) === identity.languageCode
  ));
}

export function templateIdForUpdate(
  current: OrderTemplateIdentity,
  change: { metaTemplateId?: string; templateName?: string; languageCode?: string; whatsappAccountId?: number },
  currentAccountId: number,
): string | null | undefined {
  if (change.metaTemplateId !== undefined) return change.metaTemplateId;
  // Older clients explicitly changing the target must be allowed to resolve a
  // new ID. Re-sending unchanged metadata does not unpin a stored identity.
  const changesTarget = (change.templateName !== undefined && change.templateName !== current.templateName) ||
    (change.languageCode !== undefined && change.languageCode !== current.languageCode) ||
    (change.whatsappAccountId !== undefined && change.whatsappAccountId !== currentAccountId);
  return changesTarget ? null : current.metaTemplateId;
}
