import { Router } from "express";
import {
  // loginAdmin,
  registerAdmin,
  // logoutAdmin,
  createManager,
  getBillingSettings,
  updateBillingSettings,
  resetBusinessUsage,
  updateBusinessUsage,
} from "../controllers/admin.controller";
import {
  getUsers,
  updateUser,
  deactivateUserController,
  reactivateUserController,
  permanentlyDeleteUserController,
  getUserByIdController,
  registerUser,
} from "../controllers/user.controller";
import {
  assignUserToManagerController,
  getAllUserAssignmentsController,
  removeUserAssignmentController,
} from "../controllers/manager.controller";
import {
  authenticateToken,
  requireAdmin,
  // refreshToken,
  logout,
} from "../middlewares/auth.middleware";
import {
  validateAdminRegistration,
  validateUserLogin,
  validateUserRegistration,
} from "../middlewares/validation.middleware";
import { authLimiter, adminLimiter } from "../middlewares/rateLimit.middleware";
import { getLeads } from "../controllers/lead.controller";
import {
  getAdminAnalytics,
  getUserFacebookAccounts,
  deactivateFacebookAccount,
} from "../services/meta/facebook.service";

const adminRoutes = Router();

// Admin authentication routes with rate limiting and validation

// adminRoutes.post("/login", authLimiter, validateUserLogin, loginAdmin);

// Token management routes
// adminRoutes.post("/refresh", refreshToken);
// adminRoutes.post("/logout", logoutAdmin);

// Admin-only routes (require authentication and admin role)
adminRoutes.use(authenticateToken, requireAdmin);

adminRoutes.post(
  "/addAdmin",
  authLimiter,
  validateAdminRegistration,
  registerAdmin,
);

// Manager creation (admin/super_admin only)
adminRoutes.post(
  "/create-manager",
  adminLimiter,
  validateAdminRegistration,
  createManager,
);

// user creation (admin/super_admin/manager only)
adminRoutes.post(
  "/create-user",
  adminLimiter,
  validateUserRegistration,
  registerUser,
);

// User management with admin rate limiting
adminRoutes.get("/users", adminLimiter, getUsers);
adminRoutes.get("/users/:id", adminLimiter, getUserByIdController);
adminRoutes.put("/users/:id", adminLimiter, updateUser);
adminRoutes.patch(
  "/users/:id/deactivate",
  adminLimiter,
  deactivateUserController,
);
adminRoutes.patch(
  "/users/:id/reactivate",
  adminLimiter,
  reactivateUserController,
);
adminRoutes.delete("/users/:id", adminLimiter, permanentlyDeleteUserController);

// Admin Settings management
adminRoutes.get("/settings/billing", adminLimiter, getBillingSettings);
adminRoutes.post("/settings/billing", adminLimiter, updateBillingSettings);

// Business Profile Billing Management
adminRoutes.post("/billing/profiles/:id/reset", adminLimiter, resetBusinessUsage);
adminRoutes.patch("/billing/profiles/:id/usage", adminLimiter, updateBusinessUsage);

// Lead management
adminRoutes.get("/leads", adminLimiter, getLeads);

// User assignment management
adminRoutes.post("/assign-user", adminLimiter, assignUserToManagerController);
adminRoutes.get("/assignments", adminLimiter, getAllUserAssignmentsController);
adminRoutes.delete(
  "/assignments/:id",
  adminLimiter,
  removeUserAssignmentController,
);

// Facebook account management and analytics
adminRoutes.get(
  "/facebook/analytics",
  adminLimiter,
  async (req: any, res: any) => {
    try {
      const { days = 30 } = req.query;
      const analytics = await getAdminAnalytics(parseInt(days as string));
      res.json({ data: analytics });
    } catch (error: any) {
      console.error("Get admin Facebook analytics error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

adminRoutes.get(
  "/facebook/users/:userId/accounts",
  adminLimiter,
  async (req: any, res: any) => {
    try {
      const { userId } = req.params;
      const accounts = await getUserFacebookAccounts(parseInt(userId));
      res.json({ data: accounts });
    } catch (error: any) {
      console.error("Get user Facebook accounts error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

adminRoutes.delete(
  "/facebook/accounts/:id",
  adminLimiter,
  async (req: any, res: any) => {
    try {
      const { id } = req.params;
      await deactivateFacebookAccount(parseInt(id));
      res.json({
        success: true,
        message: "Facebook account deactivated successfully",
      });
    } catch (error: any) {
      console.error("Deactivate Facebook account error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

export default adminRoutes;
