import { Router } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  toggleAiSchema,
  updateStatusSchema,
} from "../meta/core/conversation.validation";
import {
  idPaginationSchema,
  idParamSchema,
} from "@utils/shared.validation";
import { conversationsController } from "./inbox.controller";

const conversationsRoutes = Router();

/**
 * Legacy export for other controllers to use the authorization logic.
 * In the future, this should be moved to a shared service or middleware.
 */
export const getAuthorizedConversation = (userId: number, conversationId: number) => 
  conversationsController.getAuthorizedConversation(userId, conversationId);

// ─── Messages ────────────────────────────────────────────────────────────────
conversationsRoutes.get("/:id/messages", authenticateToken, validate(idPaginationSchema), (req, res) => conversationsController.listMessages(req, res));

// ─── Signals ──────────────────────────────────────────────────────────────────
conversationsRoutes.patch("/:id/read", authenticateToken, validate(idParamSchema), (req, res) => conversationsController.markRead(req, res));
conversationsRoutes.post("/:id/typing", authenticateToken, validate(idParamSchema), (req, res) => conversationsController.sendTypingSignal(req, res));

// ─── Settings & Status ────────────────────────────────────────────────────────
conversationsRoutes.patch("/:id/ai-toggle", authenticateToken, validate(idParamSchema), validate(toggleAiSchema), (req, res) => conversationsController.toggleAi(req, res));
conversationsRoutes.patch("/:id/status", authenticateToken, validate(idParamSchema), validate(updateStatusSchema), (req, res) => conversationsController.updateStatus(req, res));
conversationsRoutes.delete("/:id", authenticateToken, validate(idParamSchema), (req, res) => conversationsController.deleteConversation(req, res));

// ─── AI Draft Management (HITL) ───────────────────────────────────────────────
conversationsRoutes.put("/:id/messages/:mid/approve", authenticateToken, validate(idParamSchema), (req, res) => conversationsController.approveAiDraft(req, res));
conversationsRoutes.delete("/:id/messages/:mid", authenticateToken, validate(idParamSchema), (req, res) => conversationsController.dismissAiDraft(req, res));
conversationsRoutes.post("/:id/suggest", authenticateToken, validate(idParamSchema), (req, res) => conversationsController.suggestReply(req, res));

export default conversationsRoutes;







