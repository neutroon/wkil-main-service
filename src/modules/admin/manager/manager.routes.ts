import { Router } from "express";
import {
  createManagedUser,
  getManagerDashboardController,
  getMyManagedUsers,
  getManagedUserById,
  getManagedUserAnalytics,
  deactivateManagedUser,
  reactivateManagedUser,
  getManagedBusinessProfile,
  updateManagedBusinessProfile,
  assignUserToManagerController,
  getAllUserAssignmentsController,
  removeUserAssignmentController,
} from "./manager.controller";
import {
  authenticateToken,
  requireAdmin,
  requireManagerOrAdmin,
  requireManagerAccess,
} from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  userAssignmentSchema,
  analyticsQuerySchema,
  idParamSchema,
} from "../manager/manager.validation";
import { registerSchema } from "../../auth/core/auth.validation";
import { updateBusinessProfileSchema } from "../../business/profile/business.validation";
import { managerLimiter } from "@middlewares/rateLimit.middleware";

const managerRoutes = Router();

// All manager routes require authentication
managerRoutes.use(authenticateToken, requireManagerOrAdmin);

// user creation (admin/super_admin/manager only)
managerRoutes.post(
  "/create-user",
  managerLimiter,
  validate(registerSchema),
  createManagedUser,
);

// Manager dashboard and overview
managerRoutes.get("/dashboard", managerLimiter, getManagerDashboardController);
managerRoutes.get(
  "/my-users",
  managerLimiter,
  validate(analyticsQuerySchema),
  getMyManagedUsers,
);

// Specific user management (with access control)
managerRoutes.get(
  "/my-users/:id",
  managerLimiter,
  validate(idParamSchema),
  requireManagerAccess,
  getManagedUserById,
);
managerRoutes.get(
  "/my-users/:id/analytics",
  managerLimiter,
  validate(idParamSchema),
  validate(analyticsQuerySchema),
  requireManagerAccess,
  getManagedUserAnalytics,
);
managerRoutes.patch(
  "/my-users/:id/deactivate",
  managerLimiter,
  validate(idParamSchema),
  requireManagerAccess,
  deactivateManagedUser,
);
managerRoutes.patch(
  "/my-users/:id/reactivate",
  managerLimiter,
  validate(idParamSchema),
  requireManagerAccess,
  reactivateManagedUser,
);

managerRoutes.get(
  "/business-profiles/:id",
  managerLimiter,
  validate(idParamSchema),
  getManagedBusinessProfile,
);
managerRoutes.put(
  "/business-profiles/:id",
  managerLimiter,
  validate(updateBusinessProfileSchema),
  updateManagedBusinessProfile,
);

// Admin-only: User assignment management
managerRoutes.post(
  "/assign-user",
  managerLimiter,
  validate(userAssignmentSchema),
  requireAdmin,
  assignUserToManagerController,
);
managerRoutes.get(
  "/assignments",
  managerLimiter,
  requireAdmin,
  getAllUserAssignmentsController,
);
managerRoutes.delete(
  "/assignments/:id",
  managerLimiter,
  validate(idParamSchema),
  requireAdmin,
  removeUserAssignmentController,
);

export default managerRoutes;










