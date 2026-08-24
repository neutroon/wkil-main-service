import { Router } from "express";
import { copilotLimiter } from "@middlewares/rateLimit.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  cancelCopilotRunController,
  getCopilotConversationController,
  listCopilotMessagesController,
  postCopilotMessageController,
} from "./copilot.controller";
import { copilotMessagesQuerySchema, copilotPostMessageSchema } from "./copilot.validation";

const copilotRoutes = Router();

copilotRoutes.get("/conversation", getCopilotConversationController);
copilotRoutes.get("/conversation/messages", validate(copilotMessagesQuerySchema), listCopilotMessagesController);
copilotRoutes.post("/conversation/messages", copilotLimiter, validate(copilotPostMessageSchema), postCopilotMessageController);
copilotRoutes.delete("/runs/:runId", cancelCopilotRunController);

export default copilotRoutes;
