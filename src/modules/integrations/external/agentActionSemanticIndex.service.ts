import crypto from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "@config/prisma";
import { assertQuotaAvailable, recordAiUsage } from "@modules/billing/billing.service";
import { embedTexts } from "@modules/ai-agent/gemini";
import { AGENT_ACTION_SOURCE_LIMITS } from "./agentActionSource.constants";
import { logger } from "@utils/logger";
import { env } from "@config/env";

export type ExternalActionSemanticSource = {
  id: number;
  businessProfileId: number;
  name: string;
  description?: string | null;
  trigger?: string | null;
  actionType?: string | null;
  expectedParamsSchema?: unknown;
  isActive?: boolean | null;
};

type RoutingIndexState = {
  routingTextHash: string | null;
  routingIndexedAt: Date | null;
  hasRoutingEmbedding: boolean;
};

type SemanticHit = {
  id: number;
  similarity: number | string;
};

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(value);

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function summarizeSchema(schema: unknown): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "none";

  return Object.entries(schema as Record<string, unknown>)
    .slice(0, 24)
    .map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return key;

      const rule = value as Record<string, unknown>;
      const type = String(rule.type ?? "STRING").toUpperCase();
      const source = String(rule.source ?? "USER_PROVIDED").toUpperCase();
      const required = rule.required === true ? "required" : "optional";
      const description =
        typeof rule.description === "string" && rule.description.trim()
          ? ` - ${rule.description.trim()}`
          : "";
      return `${key}: ${type}, ${source}, ${required}${description}`;
    })
    .join("\n");
}

export function buildExternalActionRoutingText(
  source: ExternalActionSemanticSource,
): string {
  return [
    `Integration action: ${source.name}`,
    `When to use: ${source.description || "No description provided"}`,
    `Trigger: ${source.trigger || "CHAT_REQUESTED"}`,
    `Action type: ${source.actionType || "LOOKUP"}`,
    "Allowed parameters:",
    summarizeSchema(source.expectedParamsSchema),
    "Stable schema:",
    stableJson(source.expectedParamsSchema),
  ].join("\n");
}

export function hashExternalActionRoutingText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

async function getRoutingIndexState(
  sourceId: number,
): Promise<RoutingIndexState | null> {
  const rows = await prisma.$queryRaw<RoutingIndexState[]>`
    SELECT
      "routingTextHash",
      "routingIndexedAt",
      "routingEmbedding" IS NOT NULL AS "hasRoutingEmbedding"
    FROM public."AgentActionSource"
    WHERE "id" = ${sourceId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function ensureExternalActionSemanticIndex(
  source: ExternalActionSemanticSource,
): Promise<{ indexed: boolean; hash: string }> {
  const routingText = buildExternalActionRoutingText(source);
  const hash = hashExternalActionRoutingText(routingText);
  const state = await getRoutingIndexState(source.id);

  if (
    state?.hasRoutingEmbedding &&
    state.routingTextHash === hash &&
    state.routingIndexedAt
  ) {
    return { indexed: false, hash };
  }

  const profile = await prisma.businessProfile.findUnique({
    where: { id: source.businessProfileId },
    select: { userId: true },
  });
  if (!profile) return { indexed: false, hash };

  await assertQuotaAvailable(profile.userId, source.businessProfileId);

  const { embeddings, totalTokens } = await embedTexts([routingText]);
  const embedding = embeddings[0];
  if (!embedding?.length) return { indexed: false, hash };

  const vector = vectorLiteral(embedding);
  await prisma.$executeRaw`
    UPDATE public."AgentActionSource"
    SET
      "routingEmbedding" = ${vector}::vector,
      "routingTextHash" = ${hash},
      "routingIndexedAt" = NOW()
    WHERE "id" = ${source.id}
      AND "businessProfileId" = ${source.businessProfileId}
  `;

  recordAiUsage({
    userId: profile.userId,
    businessProfileId: source.businessProfileId,
    embeddingTokens: totalTokens,
    modelName: "gemini-embedding-001",
    operation: "external_action_routing_ingest",
  }).catch(console.error);

  logger.info("integration_action.semantic_index.indexed", {
    businessProfileId: source.businessProfileId,
    sourceId: source.id,
    hash,
  });

  return { indexed: true, hash };
}

export async function ensureExternalActionSemanticIndexes(
  sources: ExternalActionSemanticSource[],
): Promise<void> {
  for (const source of sources) {
    if (!source.isActive || source.trigger !== "CHAT_REQUESTED") continue;
    try {
      await ensureExternalActionSemanticIndex(source);
    } catch (error: any) {
      logger.warn("integration_action.semantic_index.index_failed", {
        businessProfileId: source.businessProfileId,
        sourceId: source.id,
        error: error?.message || String(error),
      });
    }
  }
}

export async function clearExternalActionSemanticIndex(
  sourceId: number,
  businessProfileId: number,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE public."AgentActionSource"
    SET
      "routingEmbedding" = NULL,
      "routingTextHash" = NULL,
      "routingIndexedAt" = NULL
    WHERE "id" = ${sourceId}
      AND "businessProfileId" = ${businessProfileId}
  `;
}

export async function findSemanticallyEligibleAgentActionSources<
  T extends ExternalActionSemanticSource,
>(params: {
  businessProfileId: number;
  sources: T[];
  queryEmbedding?: number[] | null;
  maxTools?: number;
  minSimilarity?: number;
}): Promise<T[]> {
  const activeSources = params.sources.filter(
    (source) =>
      source.isActive &&
      source.trigger === "CHAT_REQUESTED" &&
      source.businessProfileId === params.businessProfileId,
  );

  if (activeSources.length === 0 || !params.queryEmbedding?.length) return [];

  const maxTools =
    params.maxTools ??
    env.EXTERNAL_ACTION_MAX_SEMANTIC_TOOLS ??
    AGENT_ACTION_SOURCE_LIMITS.maxSemanticTools;
  const minSimilarity =
    params.minSimilarity ??
    env.EXTERNAL_ACTION_MIN_SEMANTIC_SIMILARITY ??
    AGENT_ACTION_SOURCE_LIMITS.minSemanticSimilarity;
  const sourceById = new Map(activeSources.map((source) => [source.id, source]));
  const sourceIds = activeSources.map((source) => source.id);
  const vector = vectorLiteral(params.queryEmbedding);

  const rows = await prisma.$queryRaw<SemanticHit[]>`
    SELECT
      "id",
      1 - ("routingEmbedding" <=> ${vector}::vector) AS similarity
    FROM public."AgentActionSource"
    WHERE "businessProfileId" = ${params.businessProfileId}
      AND "trigger" = 'CHAT_REQUESTED'
      AND "isActive" = true
      AND "routingEmbedding" IS NOT NULL
      AND "id" IN (${Prisma.join(sourceIds)})
    ORDER BY "routingEmbedding" <=> ${vector}::vector
    LIMIT ${Math.max(maxTools * 3, maxTools)}
  `;

  const ranked = rows
    .map((row) => ({ id: row.id, similarity: Number(row.similarity) }))
    .filter((row) => Number.isFinite(row.similarity));
  const eligible = ranked
    .filter((row) => row.similarity >= minSimilarity)
    .slice(0, maxTools)
    .map((row) => sourceById.get(row.id))
    .filter((source): source is T => Boolean(source));

  logger.info("integration_action.semantic_router.result", {
    businessProfileId: params.businessProfileId,
    candidateCount: activeSources.length,
    eligibleIds: eligible.map((source) => source.id),
    topSimilarity: ranked[0]?.similarity ?? null,
    secondSimilarity: ranked[1]?.similarity ?? null,
    topMargin:
      ranked.length > 1 ? ranked[0].similarity - ranked[1].similarity : null,
    minSimilarity,
  });

  return eligible;
}
