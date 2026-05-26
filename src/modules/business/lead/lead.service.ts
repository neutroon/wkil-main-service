import prisma, { Prisma } from "@config/prisma";

function buildDuplicateLeadMessage(lead: Prisma.LeadCreateInput) {
  return [
    "Duplicate lead submission",
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    lead.url ? `URL: ${lead.url}` : null,
    lead.message ? `Message:\n${lead.message}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function appendLeadMessage(currentMessage: string | null, nextMessage: string) {
  if (!currentMessage?.trim()) {
    return nextMessage;
  }

  return `${currentMessage.trim()}\n\n---\n${nextMessage}`;
}

const createLead = async (lead: Prisma.LeadCreateInput) => {
  try {
    return await prisma.lead.create({
      data: lead,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existingLead = await prisma.lead.findUnique({
        where: {
          email: lead.email,
        },
      });

      if (!existingLead) {
        throw error;
      }

      return prisma.lead.update({
        where: {
          email: lead.email,
        },
        data: {
          message: appendLeadMessage(
            existingLead.message,
            buildDuplicateLeadMessage(lead),
          ),
        },
      });
    }

    throw error;
  }
};

const getAllLeads = async () => {
  return prisma.lead.findMany();
};

export { createLead, getAllLeads };

