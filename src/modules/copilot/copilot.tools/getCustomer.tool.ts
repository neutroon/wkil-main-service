import { z } from "zod";
import { getCustomerForUser } from "@modules/business/customer/customer.service";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const getCustomerTool: CopilotToolDefinition = {
  name: "get_customer",
  description: "Look up a single customer by id (with profile, recent conversation, captured fields). Use when the owner names a customer.",
  schema: z.object({ customerId: z.number().int().min(1) }),
  requiresConfirmation: false,
  handler: async (args, ctx) => getCustomerForUser(ctx.userId, args.customerId),
};
