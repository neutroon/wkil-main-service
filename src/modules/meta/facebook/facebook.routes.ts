import { Router } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import { 
  facebookLoginSchema, 
  facebookCallbackSchema, 
  facebookSdkCallbackSchema,
  facebookValidateTokenSchema,
  facebookPagesSchema,
  facebookPostSchema,
  facebookScheduleSchema,
  facebookPageIdParamSchema,
  facebookPostIdParamSchema,
  facebookCommentIdParamSchema,
  facebookAnalyticsSchema,
  facebookIdParamSchema,
  facebookLinkBusinessSchema,
  facebookPageSettingsSchema,
  facebookPrivateReplySchema
} from "./facebook.validation";
import { facebookLimiter } from "@middlewares/rateLimit.middleware";
import { facebookController } from "./facebook.controller";

const facebookRoutes = Router();

// ─── Authentication ───────────────────────────────────────────────────────────
facebookRoutes.get("/login", validate(facebookLoginSchema), (req, res) => facebookController.login(req, res));
facebookRoutes.post("/login/callback", authenticateToken, validate(facebookCallbackSchema), (req, res) => facebookController.callback(req, res));
facebookRoutes.post("/login/sdk", authenticateToken, validate(facebookSdkCallbackSchema), (req, res) => facebookController.sdkCallback(req, res));
facebookRoutes.get("/validate-token", authenticateToken, validate(facebookValidateTokenSchema), (req, res) => facebookController.validateToken(req, res));

// ─── Accounts & Analytics ─────────────────────────────────────────────────────
facebookRoutes.get("/accounts", authenticateToken, (req, res) => facebookController.listAccounts(req, res));
facebookRoutes.delete("/accounts/:id", authenticateToken, validate(facebookIdParamSchema), (req, res) => facebookController.deactivateAccount(req, res));
facebookRoutes.post("/switch-device", authenticateToken, (req, res) => facebookController.switchDevice(req, res));
facebookRoutes.get("/analytics", authenticateToken, validate(facebookAnalyticsSchema), (req, res) => facebookController.getAnalytics(req, res));
facebookRoutes.get("/admin/analytics", authenticateToken, (req, res) => facebookController.adminGetAnalytics(req, res));

// ─── Page Management ──────────────────────────────────────────────────────────
facebookRoutes.get("/pages", facebookLimiter, authenticateToken, validate(facebookPagesSchema), (req, res) => facebookController.listPages(req, res));
facebookRoutes.post("/pages/sync", facebookLimiter, authenticateToken, (req, res) => facebookController.syncPages(req, res));
facebookRoutes.get("/pages/:pageId", facebookLimiter, authenticateToken, validate(facebookPageIdParamSchema), (req, res) => facebookController.getPageDetails(req, res));
facebookRoutes.delete("/pages/:pageId", authenticateToken, validate(facebookPageIdParamSchema), (req, res) => facebookController.disconnectPage(req, res));
facebookRoutes.post("/pages/:pageId/link-business", authenticateToken, validate(facebookPageIdParamSchema), validate(facebookLinkBusinessSchema), (req, res) => facebookController.linkBusiness(req, res));
facebookRoutes.delete("/pages/:pageId/unlink-business", authenticateToken, validate(facebookPageIdParamSchema), (req, res) => facebookController.unlinkBusiness(req, res));
facebookRoutes.patch("/pages/:pageId/settings", authenticateToken, validate(facebookPageIdParamSchema), validate(facebookPageSettingsSchema), (req, res) => facebookController.updateSettings(req, res));

// ─── Posting & Comments ───────────────────────────────────────────────────────
facebookRoutes.post("/post", facebookLimiter, authenticateToken, validate(facebookPostSchema), (req, res) => facebookController.createPost(req, res));
facebookRoutes.post("/schedule", authenticateToken, validate(facebookScheduleSchema), (req, res) => facebookController.schedulePost(req, res));
facebookRoutes.get("/page-posts/:pageId", authenticateToken, validate(facebookPageIdParamSchema), (req, res) => facebookController.getPagePosts(req, res));
facebookRoutes.delete("/post/:postId", authenticateToken, validate(facebookPostIdParamSchema), (req, res) => facebookController.deletePost(req, res));
facebookRoutes.get("/comments/:postId", authenticateToken, validate(facebookPostIdParamSchema), (req, res) => facebookController.getComments(req, res));
facebookRoutes.post("/reply/:commentId", authenticateToken, validate(facebookCommentIdParamSchema), (req, res) => facebookController.replyToComment(req, res));
facebookRoutes.post("/private-reply/:messageId", authenticateToken, validate(facebookPrivateReplySchema), (req, res) => facebookController.sendPrivateReply(req, res));

export default facebookRoutes;







