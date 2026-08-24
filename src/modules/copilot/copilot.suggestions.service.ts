import { invokeText } from "@modules/ai-agent/core/modelRuntime";
import { isCopilotUx2Enabled } from "./copilot.flags";

export type Suggestion = { text: string; why?: string };
export type SuggestionsResult = { prompts: Suggestion[]; source: "llm" | "fallback" };

const STATIC_FALLBACK: Suggestion[] = [
  { text: "Show me today's numbers" },
  { text: "Any new leads?" },
  { text: "Who needs my attention?" },
];

type CacheEntry = { value: SuggestionsResult; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000;

function cacheKey(userId: number, locale: string, kind: string): string {
  const hourBucket = Math.floor(Date.now() / TTL_MS);
  return `${userId}:${locale}:${kind}:${hourBucket}`;
}

export function invalidateSuggestions(userId: number): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) cache.delete(key);
  }
}

export async function getCopilotSuggestions(params: {
  userId: number;
  locale: "ar" | "en";
  conversationKind: "ONBOARDING" | "GENERAL";
  hour: number;
  recentTitles: string[];
}): Promise<SuggestionsResult> {
  const key = cacheKey(params.userId, params.locale, params.conversationKind);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const recent = params.recentTitles.slice(0, 5).map((t) => `- ${t}`).join("\n");
  const systemPrompt = [
    "You are the wkil copilot empty-state suggester.",
    `Locale: ${params.locale}. Time of day hour: ${params.hour}. Conversation kind: ${params.conversationKind}.`,
    recent ? `Recent conversations:\n${recent}` : "No recent conversations.",
    "Return 3-4 short owner-relevant prompt suggestions as a JSON array of objects { text: string, why: string }.",
    "Each 'text' must be 8 words or fewer. No markdown. Plain text only.",
  ].join("\n");

  try {
    const { text } = await invokeText({
      prompt: systemPrompt,
      temperature: 0.6,
      maxOutputTokens: 256,
      timeoutMs: 2000,
      context: "CopilotSuggestions",
    });
    const content = typeof text === "string" ? text : JSON.stringify(text);
    const parsed = JSON.parse(content.replace(/```json|```/g, "").trim()) as Suggestion[];
    const prompts = Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.text === "string").slice(0, 4) : [];
    if (prompts.length === 0) throw new Error("empty suggestions");
    const value: SuggestionsResult = { prompts, source: "llm" };
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch {
    return { prompts: STATIC_FALLBACK, source: "fallback" };
  }
}

export function isUx2Enabled(): boolean {
  return isCopilotUx2Enabled();
}
