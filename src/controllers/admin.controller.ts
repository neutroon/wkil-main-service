import prisma from "../config/prisma";
import { clearQuotaCache } from "../services/billing.service";
import { createAdmin } from "../services/admin.service";
import { createUser } from "../services/user.service";
import {
  getBillingMultiplier,
  updateBillingMultiplier,
} from "../services/settings.service";
import { Request, Response } from "express";


const registerAdmin = async (req: Request, res: Response) => {
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
};

// Create a new manager (admin/super_admin only)
const createManager = async (req: Request, res: Response) => {
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
};

// Settings management
export const getBillingSettings = async (req: Request, res: Response) => {
  const multiplier = await getBillingMultiplier();
  res.status(200).json({ data: { billing_multiplier: multiplier } });
};

export const updateBillingSettings = async (req: Request, res: Response) => {
  const { billing_multiplier } = req.body;
  await updateBillingMultiplier(billing_multiplier);
  res.status(200).json({ message: "Billing settings updated successfully" });
};

// Manual Billing Reset
export const resetBusinessUsage = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const businessProfileId = id;

  await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { monthlyTokensUsed: 0 },
  });

  clearQuotaCache(businessProfileId);
  res.status(200).json({ message: "Monthly tokens reset to 0 successfully" });
};

export const updateBusinessUsage = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const { tokensUsed } = req.body;
  const businessProfileId = id;

  await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { monthlyTokensUsed: tokensUsed },
  });

  clearQuotaCache(businessProfileId);
  res
    .status(200)
    .json({ message: `Monthly tokens updated to ${tokensUsed}` });
};

export { registerAdmin, createManager };
