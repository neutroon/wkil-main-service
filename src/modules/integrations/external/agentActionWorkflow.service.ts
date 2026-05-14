import type { AgentActionSource } from "@prisma/client";
import prisma from "@config/prisma";

export type AgentActionWorkflowWithSources = Awaited<
  ReturnType<typeof listAgentActionWorkflows>
>[number];

export async function listAgentActionWorkflows(businessProfileId: number) {
  return prisma.agentActionWorkflow.findMany({
    where: { businessProfileId },
    include: {
      lookupSource: true,
      mutationSource: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function listActiveAgentActionWorkflows(businessProfileId: number) {
  return prisma.agentActionWorkflow.findMany({
    where: { businessProfileId, isActive: true },
    include: {
      lookupSource: true,
      mutationSource: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export function findWorkflowStartingWithSource(
  workflows: AgentActionWorkflowWithSources[],
  sourceId: number,
) {
  return workflows.find(
    (workflow) =>
      workflow.isActive &&
      (workflow.lookupSourceId === sourceId ||
        (!workflow.lookupSourceId && workflow.mutationSourceId === sourceId)),
  );
}

export function nextMutationSourceForCompletedLookup(
  workflow: AgentActionWorkflowWithSources | null | undefined,
  completedSource: AgentActionSource | null | undefined,
) {
  if (!workflow || !completedSource) return null;
  if (workflow.lookupSourceId !== completedSource.id) return null;
  if (!workflow.mutationSource || !workflow.mutationSource.isActive) return null;
  return workflow.mutationSource;
}

export function activeWorkflowSourceIds(workflows: AgentActionWorkflowWithSources[]) {
  return new Set(
    workflows.flatMap((workflow) => [
      workflow.lookupSourceId,
      workflow.lookupSourceId ? null : workflow.mutationSourceId,
    ]).filter((id): id is number => typeof id === "number"),
  );
}
