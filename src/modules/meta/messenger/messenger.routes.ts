import { Router } from "express";
import multer from "multer";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import { sendMessengerReplySchema } from "../core/meta.validation";
import { paginationSchema, idPaginationSchema, idParamSchema } from "@utils/shared.validation";
import { messengerController } from "./messenger.controller";

const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 16 * 1024 * 1024 } 
});

const messengerRoutes = Router();

// ─── Webhook ──────────────────────────────────────────────────────────────────
messengerRoutes.get("/webhook", (req, res) => messengerController.verifyWebhook(req, res));
messengerRoutes.post("/webhook", (req, res) => messengerController.handleWebhook(req, res));

// ─── Conversations & Messages ─────────────────────────────────────────────────
messengerRoutes.get("/", authenticateToken, validate(paginationSchema), (req, res) => messengerController.listConversations(req, res));
messengerRoutes.get("/:id/messages", authenticateToken, validate(idPaginationSchema), (req, res) => messengerController.listMessages(req, res));
messengerRoutes.post("/conversations/:id/messages", authenticateToken, validate(idParamSchema), validate(sendMessengerReplySchema), (req, res) => messengerController.sendManualReply(req, res));
messengerRoutes.post("/conversations/:id/media", authenticateToken, upload.single("file"), validate(idParamSchema), (req, res) => messengerController.uploadAndSendMedia(req, res));

export default messengerRoutes;








