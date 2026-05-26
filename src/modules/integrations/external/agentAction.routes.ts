import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import prisma from "@config/prisma";
import { validate } from "@middlewares/validate.middleware";
import {
  agentActionSourceSchema,
  updateAgentActionSourceSchema,
  getAgentActionSourceSchema,
  deleteAgentActionSourceSchema,
  testAgentActionSourceSchema,
  testAgentActionWorkflowSchema,
  workflowSchema,
  updateWorkflowSchema,
  workflowIdSchema,
  validateAgentActionActivationConfig,
} from "./agentAction.validation";
import { AppError } from "@middlewares/errorHandler.middleware";
import {
  encryptExternalHeaders,
  mergeHeaderUpdate,
  serializeAgentActionSource,
  testAgentActionSourceRequest,
  testAgentActionWorkflowRequest,
} from "./agentActionExecutor.service";

const agentActionRoutes = Router();

// Middleware to ensure user owns the business profile
const authorizeBusinessProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = (req as any).user.id;
  const profileId = parseInt(req.params.profileId);

  const profile = await prisma.businessProfile.findUnique({
    where: { id: profileId, userId },
  });

  if (!profile) {
    throw new AppError("Unauthorized access to business profile", 403);
  }

  next();
};

async function assertWorkflowSourcesBelongToProfile(params: {
  profileId: number;
  lookupSourceId?: number | null;
  mutationSourceId?: number | null;
}) {
  const ids = [params.lookupSourceId, params.mutationSourceId].filter(
    (id): id is number => typeof id === "number",
  );
  if (ids.length === 0) return;

  const count = await prisma.agentActionSource.count({
    where: {
      businessProfileId: params.profileId,
      id: { in: ids },
      trigger: "CHAT_REQUESTED",
    },
  });
  if (count !== new Set(ids).size) {
    throw new AppError("Workflow action source not found for this profile", 400);
  }
}

function serializeWorkflow(workflow: any) {
  return {
    ...workflow,
    lookupSource: workflow.lookupSource
      ? serializeAgentActionSource(workflow.lookupSource)
      : null,
    mutationSource: workflow.mutationSource
      ? serializeAgentActionSource(workflow.mutationSource)
      : null,
  };
}

// Get all Agent Action sources for a profile
agentActionRoutes.get(
  "/business-profiles/:profileId",
  authenticateToken,
  validate(getAgentActionSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const sources = await prisma.agentActionSource.findMany({
      where: { businessProfileId: profileId },
    });
    return res.json(sources.map(serializeAgentActionSource));
  },
);

agentActionRoutes.get(
  "/business-profiles/:profileId/workflows",
  authenticateToken,
  validate(getAgentActionSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const workflows = await prisma.agentActionWorkflow.findMany({
      where: { businessProfileId: profileId },
      include: {
        lookupSource: true,
        mutationSource: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return res.json(workflows.map(serializeWorkflow));
  },
);

agentActionRoutes.post(
  "/business-profiles/:profileId/workflows",
  authenticateToken,
  validate(workflowSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    await assertWorkflowSourcesBelongToProfile({
      profileId,
      lookupSourceId: req.body.lookupSourceId ?? null,
      mutationSourceId: req.body.mutationSourceId ?? null,
    });

    const workflow = await prisma.agentActionWorkflow.create({
      data: {
        businessProfileId: profileId,
        name: req.body.name,
        description: req.body.description ?? null,
        lookupSourceId: req.body.lookupSourceId ?? null,
        mutationSourceId: req.body.mutationSourceId ?? null,
        inputBindings: req.body.inputBindings ?? undefined,
        isActive: req.body.isActive ?? true,
      },
      include: { lookupSource: true, mutationSource: true },
    });
    return res.json({ success: true, workflow: serializeWorkflow(workflow) });
  },
);

agentActionRoutes.post(
  "/business-profiles/:profileId/workflows/:workflowId/test",
  authenticateToken,
  validate(testAgentActionWorkflowSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const workflowId = parseInt(req.params.workflowId);
    const workflow = await prisma.agentActionWorkflow.findFirst({
      where: { id: workflowId, businessProfileId: profileId },
      include: {
        lookupSource: true,
        mutationSource: true,
      },
    });

    if (!workflow) {
      throw new AppError("Workflow not found", 404);
    }

    const response = await testAgentActionWorkflowRequest(
      workflow,
      profileId,
      {
        lookupArgs: req.body.lookupArgs ?? {},
        mutationArgs: req.body.mutationArgs ?? {},
        context: {
          customerPhone: req.body.customerPhone,
          conversationId: req.body.conversationId,
          contextValues: req.body.contextValues ?? {},
          latestUserText: req.body.latestUserText,
          historyText: req.body.historyText,
        },
        run: req.body.run === true,
      },
    );

    return res.json(response);
  },
);

agentActionRoutes.put(
  "/business-profiles/:profileId/workflows/:workflowId",
  authenticateToken,
  validate(updateWorkflowSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const workflowId = parseInt(req.params.workflowId);
    const existing = await prisma.agentActionWorkflow.findFirst({
      where: { id: workflowId, businessProfileId: profileId },
    });
    if (!existing) throw new AppError("Workflow not found", 404);

    await assertWorkflowSourcesBelongToProfile({
      profileId,
      lookupSourceId: req.body.lookupSourceId ?? existing.lookupSourceId,
      mutationSourceId: req.body.mutationSourceId ?? existing.mutationSourceId,
    });

    const workflow = await prisma.agentActionWorkflow.update({
      where: { id: workflowId },
      data: {
        name: req.body.name,
        description: req.body.description,
        lookupSourceId: req.body.lookupSourceId,
        mutationSourceId: req.body.mutationSourceId,
        inputBindings: req.body.inputBindings,
        isActive: req.body.isActive,
      },
      include: { lookupSource: true, mutationSource: true },
    });
    return res.json({ success: true, workflow: serializeWorkflow(workflow) });
  },
);

agentActionRoutes.delete(
  "/business-profiles/:profileId/workflows/:workflowId",
  authenticateToken,
  validate(workflowIdSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const workflowId = parseInt(req.params.workflowId);
    await prisma.agentActionWorkflow.deleteMany({
      where: { id: workflowId, businessProfileId: profileId },
    });
    return res.json({ success: true });
  },
);

// Create or configure a new Agent Action source
agentActionRoutes.post(
  "/business-profiles/:profileId",
  authenticateToken,
  validate(agentActionSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const {
      name,
      description,
      apiUrl,
      method,
      headers,
      trigger,
      actionType,
      executionMode,
      failureBehavior,
      confirmationPolicy,
      requestMapping,
      responseMapping,
      expectedParamsSchema,
      isActive,
    } = req.body;

    const activationError = validateAgentActionActivationConfig({
      actionType,
      trigger,
      isActive,
      expectedParamsSchema,
    });
    if (activationError) {
      throw new AppError(activationError, 400);
    }

    const newSource = await prisma.agentActionSource.create({
      data: {
        businessProfileId: profileId,
        name,
        description,
        apiUrl,
        method: method || "GET",
        headers: encryptExternalHeaders(headers),
        trigger,
        actionType,
        executionMode,
        failureBehavior,
        confirmationPolicy,
        requestMapping,
        responseMapping,
        expectedParamsSchema,
        isActive: isActive !== undefined ? isActive : true,
      },
    });

    return res.json({
      success: true,
      source: serializeAgentActionSource(newSource),
    });
  },
);

// Update an existing Agent Action source
agentActionRoutes.put(
  "/business-profiles/:profileId/:sourceId",
  authenticateToken,
  validate(updateAgentActionSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const sourceId = parseInt(req.params.sourceId);
    const {
      name,
      description,
      apiUrl,
      method,
      headers,
      trigger,
      actionType,
      executionMode,
      failureBehavior,
      confirmationPolicy,
      requestMapping,
      responseMapping,
      expectedParamsSchema,
      isActive,
    } = req.body;

    const existingSource = await prisma.agentActionSource.findFirst({
      where: { id: sourceId, businessProfileId: profileId },
    });

    if (!existingSource) {
      throw new AppError("Agent Action source not found or unauthorized", 404);
    }

    const activationError = validateAgentActionActivationConfig({
      actionType: actionType ?? existingSource.actionType,
      trigger: trigger ?? existingSource.trigger,
      isActive: isActive ?? existingSource.isActive,
      expectedParamsSchema:
        expectedParamsSchema !== undefined
          ? expectedParamsSchema
          : existingSource.expectedParamsSchema,
    });
    if (activationError) {
      throw new AppError(activationError, 400);
    }

    const updatedSource = await prisma.agentActionSource.update({
      where: { id: existingSource.id },
      data: {
        name,
        description,
        apiUrl,
        method,
        headers: mergeHeaderUpdate(existingSource.headers, headers),
        trigger,
        actionType,
        executionMode,
        failureBehavior,
        confirmationPolicy,
        requestMapping,
        responseMapping,
        expectedParamsSchema,
        isActive,
      },
    });

    return res.json({
      success: true,
      source: serializeAgentActionSource(updatedSource),
    });
  },
);

agentActionRoutes.post(
  "/business-profiles/:profileId/:sourceId/test",
  authenticateToken,
  validate(testAgentActionSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const sourceId = parseInt(req.params.sourceId);
    const source = await prisma.agentActionSource.findFirst({
      where: { id: sourceId, businessProfileId: profileId },
    });

    if (!source) {
      throw new AppError("Agent Action source not found or unauthorized", 404);
    }

    const response = await testAgentActionSourceRequest(
      source,
      profileId,
      req.body.args ?? {},
      {
        customerPhone: req.body.customerPhone,
        conversationId: req.body.conversationId,
        contextValues: req.body.contextValues ?? {},
        latestUserText: req.body.latestUserText,
        historyText: req.body.historyText,
      },
      req.body.run === true,
    );

    return res.json(response);
  },
);

// Delete an Agent Action source
agentActionRoutes.delete(
  "/business-profiles/:profileId/:sourceId",
  authenticateToken,
  validate(deleteAgentActionSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const sourceId = parseInt(req.params.sourceId);

    await prisma.agentActionSource.deleteMany({
      where: { id: sourceId, businessProfileId: profileId },
    });

    return res.json({ success: true });
  },
);

export default agentActionRoutes;






