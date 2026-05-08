import { generateContent } from "@modules/ai-agent/gemini";
import { logger } from "@utils/logger";
import type { BusinessProfileForChat } from "./businessChatReply.service";

type ExternalDataSource = BusinessProfileForChat["externalDataSources"][number];

const DEFAULT_ROUTER_TIMEOUT_MS = 2_500;
const MIN_ROUTER_TIMEOUT_MS = 1_000;
const MAX_ROUTER_TIMEOUT_MS = 10_000;
const MAX_ROUTER_SOURCES = 12;

function routingMode(source: ExternalDataSource): "STRICT" | "FAST" {
  return source.routingMode === "FAST" ? "FAST" : "STRICT";
}

function clampRouterTimeoutMs(source: ExternalDataSource): number {
  const raw = Number(source.routerTimeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_ROUTER_TIMEOUT_MS;
  return Math.min(
    MAX_ROUTER_TIMEOUT_MS,
    Math.max(MIN_ROUTER_TIMEOUT_MS, Math.trunc(raw)),
  );
}

function summarizeSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];

  return Object.entries(schema as Record<string, unknown>)
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

function buildRouterPrompt(
  sources: ExternalDataSource[],
  latestUserMessage: string,
): string {
  const toolList = sources.slice(0, MAX_ROUTER_SOURCES).map((source) => ({
    id: source.id,
    name: source.name,
    whenToUse: source.description,
    requiredInputs: summarizeSchema(source.expectedParamsSchema),
  }));

  return [
    "You are a strict router that decides which live external API tools should be visible to a customer-support AI for this single user turn.",
    "Return ONLY compact JSON with this exact shape: {\"eligibleIds\":[number],\"reasoning\":\"short reason\"}.",
    "",
    "Routing rules:",
    "- External API tools are live lookups, not default business knowledge.",
    "- Select a tool only when the latest user message explicitly asks for the live/dynamic/account/order/booking/availability/price/status information described by that specific tool.",
    "- Do not select tools for greetings, thanks, generic questions, broad feature/service questions, lead capture, complaints, handoff, or conversation closing.",
    "- Do not infer missing intent from a tool name. If the user asks a broad question that can be answered from business context, return no tools.",
    "- If the tool requires customer-provided identifiers and the user did not provide or ask about that lookup, return no tools.",
    "- It is better to return no tools than expose an unrelated tool.",
    "",
    `Latest user message: ${JSON.stringify(latestUserMessage)}`,
    `Available tools: ${JSON.stringify(toolList)}`,
  ].join("\n");
}

function parseEligibleIds(text: string, allowedIds: Set<number>): number[] {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.eligibleIds)) return [];
    return parsed.eligibleIds
      .map((id: unknown) => Number(id))
      .filter((id: number) => allowedIds.has(id));
  } catch {
    return [];
  }
}

export async function filterEligibleExternalDataSources(
  sources: ExternalDataSource[],
  latestUserMessage: string,
): Promise<ExternalDataSource[]> {
  const activeSources = sources
    .filter((source) => source.isActive)
    .slice(0, MAX_ROUTER_SOURCES);

  if (activeSources.length === 0) return [];
  if (!latestUserMessage.trim()) return [];

  const fastSources = activeSources.filter((source) => routingMode(source) === "FAST");
  const strictSources = activeSources.filter((source) => routingMode(source) === "STRICT");

  if (strictSources.length === 0) return fastSources;

  const allowedIds = new Set(strictSources.map((source) => source.id));
  const prompt = buildRouterPrompt(strictSources, latestUserMessage);
  const timeoutMs = Math.max(...strictSources.map(clampRouterTimeoutMs));

  try {
    const result = await Promise.race([
      generateContent(prompt, undefined, false, undefined, 0),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("EXTERNAL_TOOL_ROUTER_TIMEOUT")), timeoutMs),
      ),
    ]);
    const eligibleIds = parseEligibleIds(result.text || "", allowedIds);

    logger.info("ai.external_tool_router.result", {
      requested: latestUserMessage.slice(0, 120),
      fastIds: fastSources.map((source) => source.id),
      eligibleIds,
      timeoutMs,
    });

    return [
      ...fastSources,
      ...strictSources.filter((source) => eligibleIds.includes(source.id)),
    ];
  } catch (error: any) {
    logger.warn("ai.external_tool_router.failed", {
      error: error?.message || String(error),
      timeoutMs,
    });
    return fastSources;
  }
}
