import prisma, { Prisma } from "@config/prisma";
import { env } from "@config/env";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";
import { getChatRuntimeConfig } from "@modules/admin/ai-model/ai-model.service";

/**
 * AI Pipeline Registry Service
 *
 * The single source of truth for which model + performance knobs each AI
 * pipeline uses. Every runtime surface (chat, follow-ups, content, image-gen,
 * embeddings, ...) resolves through `getPipelineConfig(key)`.
 *
 * Resolution rules:
 *  - `embeddings` -> ALWAYS `["gemini-embedding-001"]` (768-dim pgvector
 *    constraint). Not configurable to non-embedding models.
 *  - `chat` or any pipeline with `inheritsChatDefault = true` -> resolves from
 *    the AiModel registry chat tiers (default-first, dormant providers
 *    filtered). This is the "use the same model as chat" option.
 *  - Otherwise -> the pipeline's own `modelIds`, falling back to chat tiers
 *    then env `AI_CHAT_FALLBACK_MODEL_TIERS` then hardcoded defaults when empty.
 *
 * The whole registry is cached in-memory (5-min TTL, cleared on any write) so
 * a chat message or content job never pays a DB hit to learn its model.
 *
 * Never throws: a misconfigured/empty registry degrades gracefully and can
 * never block an AI call.
 */

// ── Canonical pipeline keys (shared vocabulary across the backend) ────────────
export const PIPELINE_KEYS = [
  "chat",
  "media_understanding",
  "follow_up",
  "content",
  "content_brief",
  "content_plan",
  "business_analysis",
  "memory_capture",
  "image_gen",
  "embeddings",
  "recovery",
] as const;

export type PipelineKey = (typeof PIPELINE_KEYS)[number];

export const MODEL_CLASSES = ["text", "embedding", "image"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

// Pipelines whose own modelIds are always ignored (resolved to a fixed set).
const EMBEDDINGS_KEY: PipelineKey = "embeddings";
const CHAT_KEY: PipelineKey = "chat";

// The fixed embedding model — pinned because the pgvector column is vector(768)
// and changing it requires a coordinated schema migration.
const FIXED_EMBEDDING_TIERS = ["gemini-embedding-001"];

// Final hardcoded text fallback, kept in sync with FALLBACK_CHAT_TIERS in
// ai-model.service.ts and the seed scripts.
const HARDCODED_TEXT_TIERS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];

// ── Types ────────────────────────────────────────────────────────────────────
export interface PipelineRuntimeConfig {
  tiers: string[]; // ordered model IDs to try (default first)
  temperature: number | null; // null = caller's runtime default
  maxOutputTokens: number | null; // null = caller's runtime default
  timeoutMs: number | null; // null = caller's runtime default
}

export interface PipelineUpdate {
  displayName?: string;
  description?: string | null;
  modelIds?: string[];
  temperature?: number | null;
  maxOutputTokens?: number | null;
  timeoutMs?: number | null;
  inheritsChatDefault?: boolean;
  isActive?: boolean;
}

// ── In-memory cache (per-process) ────────────────────────────────────────────
// One DB read populates every pipeline for CACHE_TTL_MS. Cleared on any write.
type PipelineCacheEntry = {
  config: PipelineRuntimeConfig;
  row: PrismaAiPipelineRow;
};
type PipelineCache = {
  byKey: Map<PipelineKey, PipelineCacheEntry>;
  expiresAt: number;
};
let pipelineCache: PipelineCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearPipelineCache(): void {
  clearPipelineCacheLocal();
  // Best-effort cross-instance invalidation. Lazy import to avoid load cycles.
  void import("@config/cache-bus")
    .then(({ publishCacheInvalidation }) =>
      publishCacheInvalidation("ai_pipelines"),
    )
    .catch(() => {});
}

/** Local-only invalidation. Used by the cache-bus subscriber (no publish —
 *  the bus is the delivery mechanism, so re-publishing would loop). */
export function clearPipelineCacheLocal(): void {
  pipelineCache = null;
}

// Convenience alias so this file doesn't lean on the generated name directly
// in type positions everywhere.
type PrismaAiPipelineRow = Prisma.AiPipelineGetPayload<{}>;

function isProviderConfigured(provider: string): boolean {
  switch (provider) {
    case "google":
      return Boolean(env.GEMINI_API_KEY);
    case "openai":
      return Boolean(env.OPENAI_API_KEY);
    case "anthropic":
      return Boolean(env.ANTHROPIC_API_KEY);
    default:
      return false;
  }
}

/**
 * The set of active modelIds eligible for a given model class, filtered to
 * providers whose API key is loaded. Used to validate a pipeline's configured
 * modelIds and to compute dormant-provider exclusions.
 */
async function selectableModelIdsForClass(modelClass: ModelClass): Promise<Set<string>> {
  // Map pipeline model class -> AiModel categories that may serve it.
  const categories: string[] =
    modelClass === "text"
      ? ["chat", "multimodal"]
      : modelClass === "embedding"
        ? ["embedding"]
        : ["image"];

  const rows = await prisma.aiModel.findMany({
    where: { category: { in: categories }, isActive: true },
    select: { modelId: true, provider: true },
  });
  return new Set(
    rows.filter((r) => isProviderConfigured(r.provider)).map((r) => r.modelId),
  );
}

/**
 * Resolve the chat-tier base (used when a pipeline inherits chat default, and
 * as the fallback for standalone text pipelines). Wraps getChatRuntimeConfig
 * so this service is the only thing importing it.
 */
async function chatTiersBase(): Promise<{
  tiers: string[];
  maxOutputTokens: number | null;
}> {
  try {
    const cfg = await getChatRuntimeConfig();
    if (cfg.tiers.length > 0) {
      return { tiers: cfg.tiers, maxOutputTokens: cfg.defaultMaxOutputTokens };
    }
  } catch (error: any) {
    logger.warn("ai_pipeline.chat_resolve_failed", { error: error?.message });
  }
  const envTiers = (env.AI_CHAT_FALLBACK_MODEL_TIERS || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    tiers: envTiers.length > 0 ? envTiers : HARDCODED_TEXT_TIERS,
    maxOutputTokens: null,
  };
}

// ── Cache loading ────────────────────────────────────────────────────────────
async function loadPipelineCache(): Promise<PipelineCache> {
  const cached = pipelineCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const byKey = new Map<PipelineKey, PipelineCacheEntry>();
  try {
    const rows = await prisma.aiPipeline.findMany();
    for (const row of rows) {
      const key = row.key as PipelineKey;
      byKey.set(key, {
        row,
        config: await buildConfig(row),
      });
    }
  } catch (error: any) {
    logger.error("ai_pipeline.load_failed", { error: error?.message });
    // If the DB read failed but we have a stale cache, keep serving it rather
    // than crashing every AI call. Otherwise fall through to per-key fallbacks.
    if (cached) return cached;
  }

  const next: PipelineCache = { byKey, expiresAt: Date.now() + CACHE_TTL_MS };
  pipelineCache = next;
  return next;
}

/**
 * Builds the runtime config for a single pipeline row. Standalone image/embedding
 * rows validate their modelIds against selectable models; dormant/unknown ids are
 * dropped. Text rows that don't inherit fall back to chat tiers when empty.
 */
async function buildConfig(row: PrismaAiPipelineRow): Promise<PipelineRuntimeConfig> {
  const basePerf = {
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    timeoutMs: row.timeoutMs,
  };

  // Embeddings: always the fixed 768-dim model.
  if (row.key === EMBEDDINGS_KEY) {
    return { tiers: [...FIXED_EMBEDDING_TIERS], ...basePerf };
  }

  // chat, or any text pipeline inheriting chat default.
  if (row.key === CHAT_KEY || (row.inheritsChatDefault && row.modelClass === "text")) {
    const base = await chatTiersBase();
    return { tiers: base.tiers, ...basePerf };
  }

  // Standalone pipeline with its own modelIds. Filter to eligible, active,
  // configured-provider models for the class. If nothing remains, degrade to
  // the chat base so the surface still runs.
  if (row.modelIds.length > 0) {
    const eligible = await selectableModelIdsForClass(row.modelClass as ModelClass);
    const tiers = row.modelIds.filter((id) => eligible.has(id));
    if (tiers.length > 0) {
      return { tiers, ...basePerf };
    }
  }

  // Empty/misconfigured standalone pipeline -> fall back to chat tiers.
  const base = await chatTiersBase();
  return { tiers: base.tiers, ...basePerf };
}

// ── Public resolution (the function every runtime calls) ─────────────────────

/**
 * Resolves the runtime config for a pipeline. NEVER throws — on any failure it
 * returns a safe text-tier fallback so an AI call is never blocked by config.
 */
export async function getPipelineConfig(
  key: PipelineKey,
): Promise<PipelineRuntimeConfig> {
  try {
    const cache = await loadPipelineCache();
    const entry = cache.byKey.get(key);
    if (entry && entry.config.tiers.length > 0) {
      return entry.config;
    }
  } catch (error: any) {
    logger.warn("ai_pipeline.resolve_failed", { key, error: error?.message });
  }

  // Last-resort fallback for every pipeline: chat tiers -> hardcoded.
  const base = await chatTiersBase();
  return {
    tiers: base.tiers.length > 0 ? base.tiers : HARDCODED_TEXT_TIERS,
    temperature: null,
    maxOutputTokens: null,
    timeoutMs: null,
  };
}

/**
 * Resolves config for every pipeline in one call (used by the admin UI preview
 * endpoint and diagnostics). Never throws.
 */
export async function getAllPipelineConfigs(): Promise<
  Record<string, PipelineRuntimeConfig>
> {
  const cache = await loadPipelineCache();
  const out: Record<string, PipelineRuntimeConfig> = {};
  for (const key of PIPELINE_KEYS) {
    const entry = cache.byKey.get(key);
    out[key] = entry
      ? entry.config
      : { tiers: HARDCODED_TEXT_TIERS, temperature: null, maxOutputTokens: null, timeoutMs: null };
  }
  return out;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listPipelines() {
  const rows = await prisma.aiPipeline.findMany({
    orderBy: [{ modelClass: "asc" }, { key: "asc" }],
  });
  // Annotate with the live-resolved tiers so the UI can show what each
  // pipeline will actually use without a second round-trip from the client.
  const configs = await getAllPipelineConfigs();
  return rows.map((row) => ({
    ...row,
    resolvedTiers: configs[row.key]?.tiers ?? [],
  }));
}

export async function getPipeline(key: PipelineKey) {
  const row = await prisma.aiPipeline.findUnique({ where: { key } });
  if (!row) {
    throw new AppError("Pipeline not found", 404, true, "PIPELINE_NOT_FOUND");
  }
  const config = await getPipelineConfig(key);
  return { ...row, resolvedTiers: config.tiers };
}

export async function updatePipeline(
  key: PipelineKey,
  data: PipelineUpdate,
  actorId?: number,
) {
  const existing = await prisma.aiPipeline.findUnique({ where: { key } });
  if (!existing) {
    throw new AppError("Pipeline not found", 404, true, "PIPELINE_NOT_FOUND");
  }

  // Validate modelIds belong to a selectable model for this class (when the
  // pipeline is standalone). Inheriting pipelines ignore their modelIds, so we
  // don't block edits that include stale ids while inheriting.
  if (
    data.modelIds !== undefined &&
    !(data.inheritsChatDefault ?? existing.inheritsChatDefault) &&
    existing.modelClass !== "embedding" &&
    existing.key !== CHAT_KEY
  ) {
    const eligible = await selectableModelIdsForClass(existing.modelClass as ModelClass);
    const invalid = data.modelIds.filter((id) => !eligible.has(id));
    if (invalid.length > 0) {
      throw new AppError(
        `These models are not selectable for this pipeline (inactive, wrong class, or missing provider key): ${invalid.join(", ")}`,
        400,
        true,
        "PIPELINE_INVALID_MODELS",
      );
    }
  }

  // Image/embedding classes can never inherit chat (different model class).
  const willInherit =
    data.inheritsChatDefault ?? existing.inheritsChatDefault;
  const canInherit = existing.modelClass === "text" && existing.key !== CHAT_KEY;
  if (willInherit && !canInherit) {
    throw new AppError(
      "Only text-class pipelines can inherit the chat default",
      400,
      true,
      "PIPELINE_CANNOT_INHERIT",
    );
  }

  const updateData: Prisma.AiPipelineUpdateInput = {};
  if (data.displayName !== undefined) updateData.displayName = data.displayName;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.modelIds !== undefined) updateData.modelIds = data.modelIds;
  if (data.temperature !== undefined) updateData.temperature = data.temperature;
  if (data.maxOutputTokens !== undefined)
    updateData.maxOutputTokens = data.maxOutputTokens;
  if (data.timeoutMs !== undefined) updateData.timeoutMs = data.timeoutMs;
  if (data.inheritsChatDefault !== undefined && canInherit) {
    updateData.inheritsChatDefault = data.inheritsChatDefault;
  }
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const updated = await prisma.aiPipeline.update({
    where: { key },
    data: updateData,
  });

  clearPipelineCache();
  logger.info("ai_pipeline.updated", { actorId, key });
  const config = await getPipelineConfig(key);
  return { ...updated, resolvedTiers: config.tiers };
}
