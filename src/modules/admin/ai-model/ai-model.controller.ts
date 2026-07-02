import { Request, Response } from "express";
import type { AuthRequest } from "@modules/auth/core/auth.middleware";
import {
  listAiModels,
  getAiModel,
  createAiModel,
  updateAiModel,
  deleteAiModel,
  setDefaultChatModel,
  getActiveChatTiers,
  type AiModelCategory,
  type AiModelProvider,
} from "./ai-model.service";

const parseCategory = (v?: string): AiModelCategory | undefined =>
  v as AiModelCategory | undefined;
const parseProvider = (v?: string): AiModelProvider | undefined =>
  v as AiModelProvider | undefined;
const parseIsActive = (v?: string): boolean | undefined =>
  v === undefined ? undefined : v === "true";

// GET /v1/admin/ai-models
export const listAiModelsController = async (req: Request, res: Response) => {
  const { category, provider, isActive } = (req.query ?? {}) as {
    category?: string;
    provider?: string;
    isActive?: string;
  };
  const models = await listAiModels({
    category: parseCategory(category),
    provider: parseProvider(provider),
    isActive: parseIsActive(isActive),
  });
  res.status(200).json({ data: models });
};

// GET /v1/admin/ai-models/active/chat — resolved tiers for the chat runtime
export const getActiveChatTiersController = async (
  _req: Request,
  res: Response,
) => {
  const tiers = await getActiveChatTiers();
  // Surface both the modelId-only view (for backwards compat with the mobile
  // admin UI) and the rich view (modelId + provider) so super admins can see
  // which provider serves each tier.
  res.status(200).json({
    data: {
      tiers: tiers.map((t) => t.modelId),
      tierDetails: tiers,
    },
  });
};

// GET /v1/admin/ai-models/:id
export const getAiModelController = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const model = await getAiModel(id);
  res.status(200).json({ data: model });
};

// POST /v1/admin/ai-models
export const createAiModelController = async (
  req: AuthRequest,
  res: Response,
) => {
  const created = await createAiModel(req.body, req.user?.id);
  res.status(201).json({
    message: "AI model created successfully",
    data: created,
  });
};

// PUT /v1/admin/ai-models/:id
export const updateAiModelController = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = Number(req.params.id);
  const updated = await updateAiModel(id, req.body, req.user?.id);
  res.status(200).json({
    message: "AI model updated successfully",
    data: updated,
  });
};

// DELETE /v1/admin/ai-models/:id
export const deleteAiModelController = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = Number(req.params.id);
  const result = await deleteAiModel(id, req.user?.id);
  res.status(200).json({
    message: "AI model deleted successfully",
    data: result,
  });
};

// PATCH /v1/admin/ai-models/:id/default
export const setDefaultChatModelController = async (
  req: AuthRequest,
  res: Response,
) => {
  const id = Number(req.params.id);
  const updated = await setDefaultChatModel(id, req.user?.id);
  res.status(200).json({
    message: "Default chat model updated successfully",
    data: updated,
  });
};
