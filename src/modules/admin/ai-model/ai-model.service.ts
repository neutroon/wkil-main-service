import prisma, { Prisma } from "@config/prisma";
import { env } from "@config/env";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

/**
 * AI Model Registry Service
 *
 * Single source of truth for which AI models the platform uses. Admins/super
 * admins manage entries here; the runtime resolves tiers via
 * `getActiveChatTiers()` (DB → env → hardcoded fallback).
 *
 * Design notes:
 *  - In-memory cache mirrors settings.service.ts (5-min TTL, write-time clear)
 *    so the chat agent avoids a DB hit per message but still picks up admin
 *    changes within one cache window.
 *  - API keys are NEVER stored here; they remain in env/vault. This table holds
 *    only model identifiers, pricing, flags and ordering.
 *  - Safety rails guarantee there is always at least one active chat model and
 *    at most one chat default.
 */

// ── Runtime fallback tiers ───────────────────────────────────────────────────
// Kept in sync with the seed (prisma/seed-ai-models.ts) and the legacy
// DEFAULT_MODEL_TIERS in src/modules/ai-agent/core/modelRuntime.ts.
const FALLBACK_CHAT_TIERS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];
const CHAT_CATEGORY = "chat";

// ── In-memory cache (per-process) ────────────────────────────────────────────
type ChatTierCache = { tiers: string[]; expiresAt: number };
let chatTierCache: ChatTierCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearAiModelCache(): void {
  chatTierCache = null;
}

// ── Types ────────────────────────────────────────────────────────────────────
export type AiModelCategory = "chat" | "embedding" | "image" | "multimodal";
export type AiModelProvider = "google" | "openai" | "anthropic";

export interface AiModelInput {
  modelId: string;
  displayName: string;
  provider?: AiModelProvider;
  category?: AiModelCategory;
  tierOrder?: number;
  isActive?: boolean;
  isDefault?: boolean;
  inputPrice?: number | null;
  outputPrice?: number | null;
  maxOutputTokens?: number | null;
  metadata?: Prisma.InputJsonValue;
}

export interface AiModelUpdate {
  modelId?: string;
  displayName?: string;
  provider?: AiModelProvider;
  category?: AiModelCategory;
  tierOrder?: number;
  isActive?: boolean;
  isDefault?: boolean;
  inputPrice?: number | null;
  outputPrice?: number | null;
  maxOutputTokens?: number | null;
  metadata?: Prisma.InputJsonValue;
}

// ── Runtime resolution (used by the chat agent) ──────────────────────────────

/**
 * Returns the ordered list of active chat modelIds to try, default first.
 *
 * Resolution chain (never throws):
 *   1. Active chat models from the DB (default first, then by tierOrder)
 *   2. `AI_CHAT_MODEL_TIERS` env var (comma-separated)
 *   3. Hardcoded FALLBACK_CHAT_TIERS
 */
export async function getActiveChatTiers(): Promise<string[]> {
  const cached = chatTierCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tiers;
  }

  let tiers: string[] = [];

  try {
    const rows = await prisma.aiModel.findMany({
      where: { category: CHAT_CATEGORY, isActive: true },
      orderBy: [{ isDefault: "desc" }, { tierOrder: "asc" }, { id: "asc" }],
      select: { modelId: true, isDefault: true },
    });
    tiers = rows.map((r) => r.modelId).filter(Boolean);
  } catch (error: any) {
    logger.error("ai_model.resolve_chat_tiers_failed", {
      error: error?.message,
    });
  }

  // Fallback 1: env-configured tiers
  if (tiers.length === 0) {
    const envTiers = (env.AI_CHAT_MODEL_TIERS || "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (envTiers.length > 0) tiers = envTiers;
  }

  // Fallback 2: hardcoded defaults
  if (tiers.length === 0) {
    tiers = FALLBACK_CHAT_TIERS;
  }

  chatTierCache = { tiers, expiresAt: Date.now() + CACHE_TTL_MS };
  return tiers;
}

/**
 * The active default chat modelId, if one is configured. Useful for display
 * and for seeding agent state. Returns null when none is set (runtime then
 * uses the first tier from getActiveChatTiers()).
 *
 * `getActiveChatTiers()` orders by `isDefault DESC, tierOrder ASC`, so the
 * first element is always the default when one exists. Sharing the same
 * cache avoids a second DB read on hot paths.
 */
export async function getDefaultChatModel(): Promise<string | null> {
  const tiers = await getActiveChatTiers();
  return tiers[0] ?? null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listAiModels(filters?: {
  category?: AiModelCategory;
  provider?: AiModelProvider;
  isActive?: boolean;
}) {
  const where: Prisma.AiModelWhereInput = {};
  if (filters?.category) where.category = filters.category;
  if (filters?.provider) where.provider = filters.provider;
  if (typeof filters?.isActive === "boolean") where.isActive = filters.isActive;

  return prisma.aiModel.findMany({
    where,
    orderBy: [{ category: "asc" }, { isDefault: "desc" }, { tierOrder: "asc" }, { id: "asc" }],
  });
}

export async function getAiModel(id: number) {
  const model = await prisma.aiModel.findUnique({ where: { id } });
  if (!model) {
    throw new AppError("AI model not found", 404, true, "AI_MODEL_NOT_FOUND");
  }
  return model;
}

export async function createAiModel(data: AiModelInput, actorId?: number) {
  try {
    const created = await prisma.$transaction(async (tx) => {
      // Enforce single default per chat category
      if (data.isDefault && (data.category ?? CHAT_CATEGORY) === CHAT_CATEGORY) {
        await tx.aiModel.updateMany({
          where: { category: CHAT_CATEGORY, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.aiModel.create({
        data: {
          modelId: data.modelId,
          displayName: data.displayName,
          provider: data.provider ?? "google",
          category: data.category ?? CHAT_CATEGORY,
          tierOrder: data.tierOrder ?? 0,
          isActive: data.isActive ?? true,
          isDefault: data.isDefault ?? false,
          inputPrice: data.inputPrice ?? null,
          outputPrice: data.outputPrice ?? null,
          maxOutputTokens: data.maxOutputTokens ?? null,
          metadata: data.metadata ?? Prisma.JsonNull,
        },
      });
    });

    clearAiModelCache();
    logger.info("ai_model.created", { actorId, modelId: created.modelId });
    return created;
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    if (error?.code === "P2002") {
      throw new AppError(
        "A model with this modelId already exists",
        409,
        true,
        "AI_MODEL_DUPLICATE",
      );
    }
    throw error;
  }
}

export async function updateAiModel(
  id: number,
  data: AiModelUpdate,
  actorId?: number,
) {
  const existing = await prisma.aiModel.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError("AI model not found", 404, true, "AI_MODEL_NOT_FOUND");
  }

  // Coerce the final values up front so every check below sees the same
  // picture (invariant: "default ⇒ active" and "isDefault only on chat").
  const targetCategory = data.category ?? existing.category;
  const desiredIsDefault =
    data.isDefault === undefined
      ? existing.isDefault
      : targetCategory === CHAT_CATEGORY
        ? data.isDefault
        : false; // image/embedding/multimodal rows can never be the chat default
  const desiredIsActive =
    desiredIsDefault && targetCategory === CHAT_CATEGORY
      ? true // auto-activate: a default chat model must be active to be reachable
      : data.isActive === undefined
        ? existing.isActive
        : data.isActive;

  // Prevent removing the last active chat model
  if (
    targetCategory === CHAT_CATEGORY &&
    desiredIsActive === false &&
    existing.category === CHAT_CATEGORY &&
    existing.isActive === true
  ) {
    const remainingActive = await prisma.aiModel.count({
      where: { category: CHAT_CATEGORY, isActive: true, id: { not: id } },
    });
    if (remainingActive === 0) {
      throw new AppError(
        "Cannot deactivate the last active chat model",
        400,
        true,
        "AI_MODEL_LAST_ACTIVE",
      );
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const becomingDefault =
        targetCategory === CHAT_CATEGORY &&
        desiredIsDefault === true &&
        !existing.isDefault;
      const deactivatingDefault =
        targetCategory === CHAT_CATEGORY &&
        existing.isActive &&
        desiredIsActive === false &&
        existing.isDefault;

      // Becoming the default: clear other chat defaults first so we always
      // end up with exactly one.
      if (becomingDefault) {
        await tx.aiModel.updateMany({
          where: { category: CHAT_CATEGORY, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      // Build only the fields that actually change.
      const updateData: Prisma.AiModelUpdateInput = {};
      if (data.modelId !== undefined && data.modelId !== existing.modelId)
        updateData.modelId = data.modelId;
      if (data.displayName !== undefined && data.displayName !== existing.displayName)
        updateData.displayName = data.displayName;
      if (data.provider !== undefined && data.provider !== existing.provider)
        updateData.provider = data.provider;
      if (data.category !== undefined && data.category !== existing.category)
        updateData.category = data.category;
      if (data.tierOrder !== undefined && data.tierOrder !== existing.tierOrder)
        updateData.tierOrder = data.tierOrder;
      if (desiredIsActive !== existing.isActive) updateData.isActive = desiredIsActive;
      if (desiredIsDefault !== existing.isDefault) updateData.isDefault = desiredIsDefault;
      if (data.inputPrice !== undefined) updateData.inputPrice = data.inputPrice;
      if (data.outputPrice !== undefined) updateData.outputPrice = data.outputPrice;
      if (
        data.maxOutputTokens !== undefined &&
        data.maxOutputTokens !== existing.maxOutputTokens
      )
        updateData.maxOutputTokens = data.maxOutputTokens;
      if (data.metadata !== undefined) updateData.metadata = data.metadata;

      const updatedRow = await tx.aiModel.update({ where: { id }, data: updateData });

      // Deactivating the current chat default: mirror the delete policy and
      // promote the next active chat model so we never sit with "no default".
      if (deactivatingDefault) {
        const replacement = await tx.aiModel.findFirst({
          where: { category: CHAT_CATEGORY, isActive: true, id: { not: id } },
          orderBy: [{ tierOrder: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (replacement) {
          await tx.aiModel.update({
            where: { id: replacement.id },
            data: { isDefault: true },
          });
          logger.info("ai_model.default_promoted", {
            actorId,
            promotedId: replacement.id,
            deactivatedId: id,
          });
        }
      }

      return updatedRow;
    });

    clearAiModelCache();
    logger.info("ai_model.updated", { actorId, modelId: updated.modelId, id });
    return updated;
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    if (error?.code === "P2002") {
      throw new AppError(
        "A model with this modelId already exists",
        409,
        true,
        "AI_MODEL_DUPLICATE",
      );
    }
    throw error;
  }
}

export async function deleteAiModel(id: number, actorId?: number) {
  const existing = await prisma.aiModel.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError("AI model not found", 404, true, "AI_MODEL_NOT_FOUND");
  }

  // Protect the last active chat model
  if (existing.category === CHAT_CATEGORY && existing.isActive) {
    const remainingActive = await prisma.aiModel.count({
      where: { category: CHAT_CATEGORY, isActive: true, id: { not: id } },
    });
    if (remainingActive === 0) {
      throw new AppError(
        "Cannot delete the last active chat model",
        400,
        true,
        "AI_MODEL_LAST_ACTIVE",
      );
    }
  }

  await prisma.aiModel.delete({ where: { id } });

  // If we removed the chat default, promote the first remaining active one
  if (existing.category === CHAT_CATEGORY && existing.isDefault) {
    const promote = await prisma.aiModel.findFirst({
      where: { category: CHAT_CATEGORY, isActive: true },
      orderBy: [{ tierOrder: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (promote) {
      await prisma.aiModel.update({
        where: { id: promote.id },
        data: { isDefault: true },
      });
      logger.info("ai_model.default_promoted", {
        actorId,
        promotedId: promote.id,
        removedId: id,
      });
    }
  }

  clearAiModelCache();
  logger.info("ai_model.deleted", { actorId, modelId: existing.modelId, id });
  return { id };
}

/**
 * Set a chat model as the platform default. Auto-activates it if inactive and
 * atomically clears any other chat default.
 */
export async function setDefaultChatModel(id: number, actorId?: number) {
  const target = await prisma.aiModel.findUnique({ where: { id } });
  if (!target) {
    throw new AppError("AI model not found", 404, true, "AI_MODEL_NOT_FOUND");
  }
  if (target.category !== CHAT_CATEGORY) {
    throw new AppError(
      "Only chat models can be set as the default chat model",
      400,
      true,
      "AI_MODEL_NOT_CHAT",
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.aiModel.updateMany({
      where: { category: CHAT_CATEGORY, isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
    return tx.aiModel.update({
      where: { id },
      data: { isDefault: true, isActive: true },
    });
  });

  clearAiModelCache();
  logger.info("ai_model.default_set", { actorId, modelId: updated.modelId, id });
  return updated;
}
