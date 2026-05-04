import { Router } from "express";
import multer from "multer";
import {
  authenticateToken,
  requireAdmin,
} from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import { idParamSchema } from "@utils/shared.validation";
import { paginationSchema, idPaginationSchema } from "@utils/shared.validation";
import { sendMessageSchema } from "@modules/meta/core/conversation.validation";
import { sendWhatsAppTemplateSchema } from "@modules/meta/core/meta.validation";
import conversationsRoutes from "@modules/inbox/inbox.routes";
import { whatsappController } from "@modules/meta/whatsapp/whatsapp.controller";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

const whatsappRoutes = Router();

// ─── Sub-routers ──────────────────────────────────────────────────────────────
whatsappRoutes.use("/conversations", (req, res, next) => {
  const isWhatsAppSpecific =
    (req.method === "GET" && req.path === "/") ||
    (req.method === "POST" && /^\/\d+\/messages$/.test(req.path)) ||
    (req.method === "GET" && req.path === "/templates") ||
    (req.method === "POST" && /^\/\d+\/template$/.test(req.path));

  if (isWhatsAppSpecific) {
    next();
  } else {
    conversationsRoutes(req, res, next);
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────
whatsappRoutes.get("/webhook", (req, res) =>
  whatsappController.verifyWebhook(req, res),
);
whatsappRoutes.post("/webhook", (req, res) =>
  whatsappController.handleWebhook(req, res),
);

// ─── OAuth & Signup ───────────────────────────────────────────────────────────
whatsappRoutes.get("/oauth/phone-numbers", authenticateToken, (req, res) =>
  whatsappController.oauthPreview(req, res),
);
whatsappRoutes.post("/oauth", authenticateToken, (req, res) =>
  whatsappController.oauthConnect(req, res),
);

// ─── Account Management ───────────────────────────────────────────────────────
whatsappRoutes.get("/accounts", authenticateToken, (req, res) =>
  whatsappController.listAccounts(req, res),
);
whatsappRoutes.delete(
  "/accounts/:id",
  authenticateToken,
  validate(idParamSchema),
  (req, res) => whatsappController.deactivateAccount(req, res),
);
whatsappRoutes.post(
  "/accounts/:id/link-business",
  authenticateToken,
  validate(idParamSchema),
  (req, res) => whatsappController.linkBusiness(req, res),
);
whatsappRoutes.delete(
  "/accounts/:id/unlink-business",
  authenticateToken,
  validate(idParamSchema),
  (req, res) => whatsappController.unlinkBusiness(req, res),
);

// ─── Inbox / Conversations ────────────────────────────────────────────────────
whatsappRoutes.get(
  "/conversations",
  authenticateToken,
  validate(paginationSchema),
  (req, res) => whatsappController.listConversations(req, res),
);
whatsappRoutes.get(
  "/conversations/:id/messages",
  authenticateToken,
  validate(idParamSchema),
  validate(idPaginationSchema),
  (req, res) => whatsappController.listMessages(req, res),
);
whatsappRoutes.post(
  "/conversations/:id/messages",
  authenticateToken,
  validate(idParamSchema),
  validate(sendMessageSchema),
  (req, res) => whatsappController.sendManualReply(req, res),
);
whatsappRoutes.post(
  "/conversations/:id/media",
  authenticateToken,
  upload.single("file"),
  validate(idParamSchema),
  (req, res) => whatsappController.uploadAndSendMedia(req, res),
);

// ─── Templates ────────────────────────────────────────────────────────────────
whatsappRoutes.get("/templates", authenticateToken, (req, res) =>
  whatsappController.listTemplates(req, res),
);
whatsappRoutes.post(
  "/conversations/:id/template",
  authenticateToken,
  validate(idParamSchema),
  validate(sendWhatsAppTemplateSchema),
  (req, res) => whatsappController.sendTemplate(req, res),
);

// ─── Admin Routes ─────────────────────────────────────────────────────────────
whatsappRoutes.get(
  "/admin/users/:userId/accounts",
  authenticateToken,
  requireAdmin,
  (req, res) => whatsappController.adminListUserAccounts(req, res),
);
whatsappRoutes.post(
  "/admin/transfer",
  authenticateToken,
  requireAdmin,
  (req, res) => whatsappController.adminTransfer(req, res),
);

export default whatsappRoutes;
