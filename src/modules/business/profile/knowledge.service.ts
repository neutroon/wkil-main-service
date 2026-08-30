import prisma from "@config/prisma";
import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { AppError } from "@middlewares/errorHandler.middleware";

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const DOC_SELECT = { id: true, businessProfileId: true, kind: true, title: true, content: true } as const;

function assertKind(kind: string) {
  if (!KIND_RE.test(kind)) throw new AppError("Invalid knowledge document kind.", 400);
}

export async function ingestProfileDocuments(profileId: number) {
  const documents = await prisma.knowledgeDocument.findMany({
    where: { businessProfileId: profileId },
    select: DOC_SELECT,
  });
  await AgentClient.ingestRag({ business_profile_id: profileId, documents, mode: "partial" });
}

export async function listKnowledgeDocuments(
  profileId: number,
  opts: { kind?: string; q?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      businessProfileId: profileId,
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.q ? { OR: [{ title: { contains: opts.q } }, { content: { contains: opts.q } }] } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  return {
    documents,
    envelopes: [{
      type: "knowledge-list",
      documents: documents.map((d) => ({ id: d.id, kind: d.kind, title: d.title, preview: d.content.slice(0, 120) })),
      total: documents.length,
      cite: { tool: "list_knowledge", fetchedAt: new Date().toISOString(), deepLink: "/agent-setup" },
    }],
  };
}

export async function createKnowledgeDocument(
  profileId: number,
  data: { kind: string; title?: string; content: string },
) {
  assertKind(data.kind);
  const document = await prisma.knowledgeDocument.create({
    data: { businessProfileId: profileId, kind: data.kind, title: data.title ?? null, content: data.content },
  });
  await ingestProfileDocuments(profileId);
  return document;
}

async function getOwnedDocument(profileId: number, id: number) {
  const existing = await prisma.knowledgeDocument.findFirst({ where: { id, businessProfileId: profileId } });
  if (!existing) throw new AppError("Knowledge document not found.", 404);
  return existing;
}

export async function updateKnowledgeDocument(
  profileId: number,
  id: number,
  data: { kind?: string; title?: string; content?: string },
) {
  if (data.kind) assertKind(data.kind);
  await getOwnedDocument(profileId, id);
  const document = await prisma.knowledgeDocument.update({ where: { id }, data });
  await ingestProfileDocuments(profileId);
  return document;
}

export async function deleteKnowledgeDocument(profileId: number, id: number) {
  await getOwnedDocument(profileId, id);
  await prisma.knowledgeDocument.delete({ where: { id } });
  await ingestProfileDocuments(profileId);
  return { ok: true } as const;
}
