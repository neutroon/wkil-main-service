// import { Lead } from "@prisma/client";
import prisma, { Prisma } from "@config/prisma";

const createLead = async (lead: Prisma.LeadCreateInput) => {
  return prisma.lead.create({
    data: lead,
  });
};

const getAllLeads = async () => {
  return prisma.lead.findMany();
};

export { createLead, getAllLeads };



