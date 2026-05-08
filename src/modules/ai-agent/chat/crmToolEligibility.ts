import { generateContent } from "@modules/ai-agent/gemini";
import { logger } from "@utils/logger";
import type { BusinessProfileForChat } from "./businessChatReply.service";

type CrmIntegration = BusinessProfileForChat["crmIntegrations"][number];

const CRM_ROUTER_TIMEOUT_MS = 2_500;

function summarizeFieldMapping(fieldMapping: unknown): string[] {
  if (!fieldMapping || typeof fieldMapping !== "object" || Array.isArray(fieldMapping)) {
    return [];
  }

  return Object.entries(fieldMapping as Record<string, unknown>)
    .slice(0, 20)
    .map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return key;
      }
      const rule = value as Record<string, unknown>;
      const type = String(rule.type ?? "STRING").toUpperCase();
      const source = String(rule.source ?? "USER_PROVIDED").toUpperCase();
      const required = rule.required === true ? "required" : "optional";
      const description =
        typeof rule.description === "string" && rule.description.trim()
          ? `: ${rule.description.trim()}`
          : "";
      return `${key} (${type}, ${source}, ${required})${description}`;
    });
}

function buildCrmRouterPrompt(params: {
  latestUserMessage: string;
  leadCaptureInstructions?: string | null;
  integration: CrmIntegration;
}): string {
  return [
    "You are a strict router that decides whether a CRM lead-capture tool should be visible to a customer-support AI for this single user turn.",
    "Return ONLY compact JSON with this exact shape: {\"expose\":boolean,\"reasoning\":\"short reason\"}.",
    "",
    "CRM lead capture is a side-effect action. It may create or update a lead in a business system.",
    "Expose the CRM tool only when the latest user message clearly shows lead-capture intent, such as asking for a callback/demo/quote/booking, saying they want to proceed/subscribe/buy, or providing contact details for follow-up.",
    "Do not expose the CRM tool for greetings, pricing questions, generic product questions, support questions, complaints, broad feature/service questions, or requests that only need a normal answer.",
    "Do not expose the CRM tool just because CRM required fields could be filled. Intent must be explicit.",
    "If uncertain, return expose=false.",
    "",
    `Latest user message: ${JSON.stringify(params.latestUserMessage)}`,
    `Admin lead-capture instructions: ${JSON.stringify(params.leadCaptureInstructions || "")}`,
    `CRM provider: ${JSON.stringify(params.integration.provider)}`,
    `CRM fields: ${JSON.stringify(summarizeFieldMapping(params.integration.fieldMapping))}`,
  ].join("\n");
}

function parseExpose(text: string): boolean {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return parsed?.expose === true;
  } catch {
    return false;
  }
}

export async function shouldExposeCrmTool(params: {
  latestUserMessage: string;
  leadCaptureInstructions?: string | null;
  integration?: CrmIntegration | null;
}): Promise<boolean> {
  const { latestUserMessage, leadCaptureInstructions, integration } = params;
  if (!integration?.isActive) return false;
  if (!latestUserMessage.trim()) return false;

  const prompt = buildCrmRouterPrompt({
    latestUserMessage,
    leadCaptureInstructions,
    integration,
  });

  try {
    const result = await Promise.race([
      generateContent(prompt, undefined, false, undefined, 0),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("CRM_TOOL_ROUTER_TIMEOUT")), CRM_ROUTER_TIMEOUT_MS),
      ),
    ]);

    const expose = parseExpose(result.text || "");
    logger.info("ai.crm_tool_router.result", {
      requested: latestUserMessage.slice(0, 120),
      integrationId: integration.id,
      expose,
    });
    return expose;
  } catch (error: any) {
    logger.warn("ai.crm_tool_router.failed", {
      error: error?.message || String(error),
      integrationId: integration.id,
    });
    return false;
  }
}
