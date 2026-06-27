import { Request, Response } from "express";
import type { AuthRequest } from "@modules/auth/core/auth.middleware";
import {
  listPipelines,
  getPipeline,
  updatePipeline,
  getAllPipelineConfigs,
  type PipelineKey,
} from "./ai-pipeline.service";

// GET /v1/admin/ai-pipelines — all pipelines with their live-resolved tiers
export const listPipelinesController = async (_req: Request, res: Response) => {
  const pipelines = await listPipelines();
  res.status(200).json({ data: pipelines });
};

// GET /v1/admin/ai-pipelines/resolved — { [key]: { tiers, temperature, ... } }
export const getResolvedPipelinesController = async (
  _req: Request,
  res: Response,
) => {
  const configs = await getAllPipelineConfigs();
  res.status(200).json({ data: configs });
};

// GET /v1/admin/ai-pipelines/:key
export const getPipelineController = async (req: Request, res: Response) => {
  const pipeline = await getPipeline(req.params.key as PipelineKey);
  res.status(200).json({ data: pipeline });
};

// PUT /v1/admin/ai-pipelines/:key — super_admin only (enforced at the route)
export const updatePipelineController = async (
  req: AuthRequest,
  res: Response,
) => {
  const updated = await updatePipeline(
    req.params.key as PipelineKey,
    req.body,
    req.user?.id,
  );
  res.status(200).json({
    message: "Pipeline updated successfully",
    data: updated,
  });
};
