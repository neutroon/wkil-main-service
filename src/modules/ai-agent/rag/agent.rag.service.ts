import prisma from "@config/prisma";

const DOCUMENT_SELECT = {
  id: true,
  businessProfileId: true,
  kind: true,
  title: true,
  content: true,
} as const;

export async function beginRagRefresh(businessProfileId: number) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const state = await tx.ragIndexState.upsert({
            where: { businessProfileId },
            create: { businessProfileId, requestedRevision: 1 },
            update: { requestedRevision: { increment: 1 } },
            select: { requestedRevision: true },
          });
          const documents = await tx.knowledgeDocument.findMany({
            where: { businessProfileId },
            orderBy: { id: "asc" },
            select: DOCUMENT_SELECT,
          });
          return {
            revision: state.requestedRevision,
            documents: documents.map((document) => ({
              id: document.id,
              business_profile_id: businessProfileId,
              kind: document.kind,
              title: document.title,
              content: document.content,
            })),
          };
        },
        { isolationLevel: "RepeatableRead" },
      );
    } catch (error: any) {
      if (error?.code !== "P2034" || attempt === 2) throw error;
    }
  }
  throw new Error("unreachable");
}

export async function commitRagRefresh(businessProfileId: number, revision: number) {
  const publication = await prisma.ragIndexState.updateMany({
    where: { businessProfileId, requestedRevision: revision },
    data: { activeRevision: revision },
  });
  if (publication.count === 1) {
    return { published: true, active_revision: revision };
  }
  const current = await prisma.ragIndexState.findUnique({
    where: { businessProfileId },
    select: { activeRevision: true },
  });
  const activeRevision = current?.activeRevision ?? null;
  return {
    published: activeRevision === revision,
    active_revision: activeRevision,
  };
}

export async function getActiveRagRevision(businessProfileId: number) {
  const state = await prisma.ragIndexState.findUnique({
    where: { businessProfileId },
    select: { activeRevision: true },
  });
  return { active_revision: state?.activeRevision ?? null };
}
