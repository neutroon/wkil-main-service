import prisma from "../config/prisma";
import { clearQuotaCache } from "../services/billing.service";
import { createAdmin } from "../services/admin.service";
import { createUser, updateUserRole } from "../services/user.service";
import {
  getBillingMultiplier,
  updateBillingMultiplier,
} from "../services/settings.service";
import {
  // setAdminAuthCookies,
  // clearAdminAuthCookies,
  setAuthCookies,
  clearAuthCookies,
} from "../middlewares/auth.middleware";
import { Request, Response } from "express";

const registerAdmin = async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;
    const admin = await createAdmin(name, email, password);
    res.status(201).json({
      message: "Admin created successfully",
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        createdAt: admin.createdAt,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// const loginAdmin = async (req: Request, res: Response) => {
//   try {
//     const { email, password } = req.body;
//     const result = await login(email, password);

//     // Set HTTP-only cookies
//     setAuthCookies(res, result.accessToken, result.refreshToken);

//     res.status(200).json({
//       message: "Admin login successful",
//       admin: {
//         id: result.id,
//         name: result.name,
//         email: result.email,
//         role: result.role,
//       },
//     });
//   } catch (err: any) {
//     res.status(400).json({ error: err.message });
//   }
// };

// const logoutAdmin = async (req: Request, res: Response) => {
//   try {
//     clearAuthCookies(res);
//     res.status(200).json({ message: "Admin logged out successfully" });
//   } catch (err: any) {
//     res.status(400).json({ error: err.message });
//   }
// };

// Create a new manager (admin/super_admin only)
const createManager = async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;
    const manager = await createUser(name, email, password, "manager");
    res.status(201).json({
      message: "Manager created successfully",
      manager: {
        id: manager.id,
        name: manager.name,
        email: manager.email,
        role: manager.role,
        createdAt: manager.createdAt,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// Settings management
export const getBillingSettings = async (req: Request, res: Response) => {
  try {
    const multiplier = await getBillingMultiplier();
    res.status(200).json({ data: { billing_multiplier: multiplier } });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const updateBillingSettings = async (req: Request, res: Response) => {
  try {
    const { billing_multiplier } = req.body;
    if (billing_multiplier === undefined) {
      return res.status(400).json({ error: "billing_multiplier is required" });
    }

    await updateBillingMultiplier(parseFloat(billing_multiplier));
    res.status(200).json({ message: "Billing settings updated successfully" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// Manual Billing Reset
export const resetBusinessUsage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const businessProfileId = parseInt(id);

    await prisma.businessProfile.update({
      where: { id: businessProfileId },
      data: { monthlyTokensUsed: 0 },
    });

    clearQuotaCache(businessProfileId);
    res.status(200).json({ message: "Monthly tokens reset to 0 successfully" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const updateBusinessUsage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tokensUsed } = req.body;
    const businessProfileId = parseInt(id);

    if (tokensUsed === undefined) {
      return res.status(400).json({ error: "tokensUsed is required" });
    }

    await prisma.businessProfile.update({
      where: { id: businessProfileId },
      data: { monthlyTokensUsed: parseInt(tokensUsed) },
    });

    clearQuotaCache(businessProfileId);
    res
      .status(200)
      .json({ message: `Monthly tokens updated to ${tokensUsed}` });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export { registerAdmin, createManager };
