

export const CHUNK_TYPE_FIELDS: Record<string, string[]> = {
  identity: ["name", "identity", "voice", "tone", "targetAudience"],
  product: ["productsServices"],
  contact: ["phoneNumbers", "address", "workingHours"],
  faq: ["faqs"],
  intents: ["expectedUserIntents", "corePolicies"],
  raw_content: ["scrapedMarkdown"],
  custom_section: ["knowledgeSections"],
};

