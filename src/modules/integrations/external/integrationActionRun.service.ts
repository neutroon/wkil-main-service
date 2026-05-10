import prisma from "@config/prisma";
import { logger } from "@utils/logger";

export type IntegrationActionRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED";

type JsonRecord = Record<string, unknown>;

export async function createIntegrationActionRun(params: {
  businessProfileId: number;
  sourceId: number;
  conversationId?: number | null;
  customerId?: number | null;
  trigger: string;
  actionType?: string | null;
  toolName?: string | null;
  jobId: string;
  requestPayload?: JsonRecord | null;
}) {
  return prisma.integrationActionRun.create({
    data: {
      businessProfileId: params.businessProfileId,
      sourceId: params.sourceId,
      conversationId: params.conversationId ?? null,
      customerId: params.customerId ?? null,
      trigger: params.trigger,
      actionType: params.actionType ?? null,
      toolName: params.toolName ?? null,
      jobId: params.jobId,
      requestPayload: params.requestPayload ?? undefined,
      status: "QUEUED",
    },
  });
}

export async function markIntegrationActionRunRunning(id?: number | null) {
  if (!id) return;
  await updateActionRun(id, {
    status: "RUNNING",
    startedAt: new Date(),
  });
}

export async function markIntegrationActionRunSucceeded(params: {
  id?: number | null;
  responsePayload?: unknown;
  verification?: string | null;
  resultMessageId?: number | null;
}) {
  if (!params.id) return;
  await updateActionRun(params.id, {
    status: "SUCCEEDED",
    responsePayload: normalizeJson(params.responsePayload),
    verification: params.verification ?? null,
    resultMessageId: params.resultMessageId ?? null,
    completedAt: new Date(),
  });
}

export async function markIntegrationActionRunFailed(params: {
  id?: number | null;
  reason: string;
  responsePayload?: unknown;
  verification?: string | null;
}) {
  if (!params.id) return;
  await updateActionRun(params.id, {
    status: "FAILED",
    failureReason: params.reason,
    responsePayload: normalizeJson(params.responsePayload),
    verification: params.verification ?? null,
    failedAt: new Date(),
  });
}

export async function markIntegrationActionRunSkipped(params: {
  id?: number | null;
  reason: string;
}) {
  if (!params.id) return;
  await updateActionRun(params.id, {
    status: "SKIPPED",
    failureReason: params.reason,
    completedAt: new Date(),
  });
}

async function updateActionRun(id: number, data: Record<string, unknown>) {
  try {
    const run = await prisma.integrationActionRun.update({
      where: { id },
      data,
      select: {
        id: true,
        businessProfileId: true,
        conversationId: true,
        status: true,
        sourceId: true,
        trigger: true,
      },
    });

    import("@modules/realtime/socketSync.service")
      .then(({ syncIntegrationActionStatus }) => {
        syncIntegrationActionStatus({
          businessProfileId: run.businessProfileId,
          conversationId: run.conversationId,
          actionRunId: run.id,
          sourceId: run.sourceId,
          trigger: run.trigger,
          status: run.status,
        });
      })
      .catch(() => {});
  } catch (error: any) {
    logger.warn("integration_action.run_update_failed", {
      id,
      status: data.status,
      error: error?.message || String(error),
    });
  }
}

function normalizeJson(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
}
