import { Router, Request, Response } from "express";
import {
  registerAdmin,
  createManager,
  createPlatformUser,
  getBillingSettings,
  updateBillingSettings,
  resetBusinessUsage,
  updateBusinessUsage,
  getAdminBusinessProfile,
  updateAdminBusinessProfile,
} from "./admin.controller";
import {
  getUsers,
  updateUser,
  deactivateUserController,
  reactivateUserController,
  permanentlyDeleteUserController,
  getUserByIdController,
} from "../../auth/user/user.controller";
import {
  assignUserToManagerController,
  getAllUserAssignmentsController,
  removeUserAssignmentController,
} from "../manager/manager.controller";
import {
  authenticateToken,
  requireAdmin,
} from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import { 
  createAdminManagerSchema,
  updateBillingSettingsSchema,
  updateBusinessUsageSchema,
  adminBusinessIdParamSchema
} from "../core/admin.validation";
import { 
  registerUserSchema, 
  updateUserSchema, 
  userIdParamSchema, 
  userListQuerySchema 
} from "../../auth/user/user.validation";
import { facebookAnalyticsSchema } from "../../meta/facebook/facebook.validation";
import { updateBusinessProfileSchema } from "../../business/profile/business.validation";
import { authLimiter, adminLimiter } from "@middlewares/rateLimit.middleware";
import { getLeads } from "../../business/lead/lead.controller";
import {
  getAdminAnalytics,
  getUserFacebookAccounts,
  deactivateFacebookAccount,
} from "../../meta/facebook/facebook.service";

const adminRoutes = Router();

// Admin-only routes (require authentication and admin role)
adminRoutes.use(authenticateToken, requireAdmin);

adminRoutes.post(
  "/addAdmin",
  authLimiter,
  validate(createAdminManagerSchema),
  registerAdmin,
);

// Manager creation (admin/super_admin only)
adminRoutes.post(
  "/create-manager",
  adminLimiter,
  validate(createAdminManagerSchema),
  createManager,
);

// user creation (admin/super_admin/manager only)
adminRoutes.post(
  "/create-user",
  adminLimiter,
  validate(registerUserSchema),
  createPlatformUser,
);

// User management with admin rate limiting
adminRoutes.get("/users", adminLimiter, validate(userListQuerySchema), getUsers);
adminRoutes.get("/users/:id", adminLimiter, validate(userIdParamSchema), getUserByIdController);
adminRoutes.put("/users/:id", adminLimiter, validate(updateUserSchema), updateUser);
adminRoutes.patch(
  "/users/:id/deactivate",
  adminLimiter,
  validate(userIdParamSchema),
  deactivateUserController,
);
adminRoutes.patch(
  "/users/:id/reactivate",
  adminLimiter,
  validate(userIdParamSchema),
  reactivateUserController,
);
adminRoutes.delete("/users/:id", adminLimiter, validate(userIdParamSchema), permanentlyDeleteUserController);

// Admin Settings management
adminRoutes.get("/settings/billing", adminLimiter, getBillingSettings);
adminRoutes.post("/settings/billing", adminLimiter, validate(updateBillingSettingsSchema), updateBillingSettings);

// Business Profile Billing Management
adminRoutes.post("/billing/profiles/:id/reset", adminLimiter, validate(adminBusinessIdParamSchema), resetBusinessUsage);
adminRoutes.patch("/billing/profiles/:id/usage", adminLimiter, validate(updateBusinessUsageSchema), updateBusinessUsage);

// Business Profile Support Management
adminRoutes.get(
  "/business-profiles/:id",
  adminLimiter,
  validate(adminBusinessIdParamSchema),
  getAdminBusinessProfile,
);
adminRoutes.put(
  "/business-profiles/:id",
  adminLimiter,
  validate(updateBusinessProfileSchema),
  updateAdminBusinessProfile,
);

// Lead management
adminRoutes.get("/leads", adminLimiter, getLeads);

// User assignment management
adminRoutes.post("/assign-user", adminLimiter, assignUserToManagerController);
adminRoutes.get("/assignments", adminLimiter, getAllUserAssignmentsController);
adminRoutes.delete(
  "/assignments/:id",
  adminLimiter,
  validate(adminBusinessIdParamSchema),
  removeUserAssignmentController,
);

// Facebook account management and analytics
adminRoutes.get(
  "/facebook/analytics",
  adminLimiter,
  validate(facebookAnalyticsSchema),
  async (req: Request, res: Response) => {
    const { days } = req.query as any;
    const analytics = await getAdminAnalytics(days);
    res.json({ data: analytics });
  },
);

adminRoutes.get(
  "/facebook/users/:userId/accounts",
  adminLimiter,
  async (req: Request, res: Response) => {
    const userId = parseInt(req.params.userId as any);
    const accounts = await getUserFacebookAccounts(userId);
    res.json({ data: accounts });
  },
);

adminRoutes.delete(
  "/facebook/accounts/:id",
  adminLimiter,
  async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as any);
    await deactivateFacebookAccount(id);
    res.json({
      success: true,
      message: "Facebook account deactivated successfully",
    });
  },
);

export default adminRoutes;












