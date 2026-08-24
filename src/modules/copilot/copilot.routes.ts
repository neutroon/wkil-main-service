import { Router } from "express";
import { copilotLimiter } from "@middlewares/rateLimit.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  cancelCopilotRunController,
  createConversationController,
  deleteConversationController,
  getCopilotConversationController,
  listConversationsController,
  listCopilotMessagesController,
  postCopilotMessageController,
  regenerateCopilotMessageController,
  updateConversationTitleController,
} from "./copilot.controller";
import { copilotMessagesQuerySchema, copilotPostMessageSchema } from "./copilot.validation";
import { getSuggestionsController, getUx2FlagController } from "./copilot.suggestions.controller";

const copilotRoutes = Router();

copilotRoutes.get("/suggestions", getSuggestionsController);
copilotRoutes.get("/ux2", getUx2FlagController);
copilotRoutes.get("/conversation", getCopilotConversationController);
copilotRoutes.get("/conversation/messages", validate(copilotMessagesQuerySchema), listCopilotMessagesController);
copilotRoutes.post("/conversation/messages", copilotLimiter, validate(copilotPostMessageSchema), postCopilotMessageController);
copilotRoutes.post("/messages/:userMsgId/regenerate", regenerateCopilotMessageController);
copilotRoutes.delete("/runs/:runId", cancelCopilotRunController);

copilotRoutes.get("/conversations", listConversationsController);
copilotRoutes.post("/conversations", createConversationController);
copilotRoutes.patch("/conversations/:id", updateConversationTitleController);
copilotRoutes.delete("/conversations/:id", deleteConversationController);

export default copilotRoutes;
