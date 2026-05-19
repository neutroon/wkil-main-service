import prisma from "@config/prisma";
import { clearQuotaCache } from "@modules/billing/billing.service";
import { createAdmin } from "../core/admin.service";
import { createUser } from "../../auth/user/user.service";
import {
  getBillingMultiplier,
  updateBillingMultiplier,
} from "@modules/settings/settings.service";
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
  const businessProfileId = Number(id);

  const businessProfile = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { userId: true },
  });

  if (!businessProfile) {
    res.status(404).json({ message: "Business profile not found" });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.businessProfile.update({
      where: { id: businessProfileId },
      data: { monthlyTokensUsed: 0, monthlyCreditsUsed: 0 },
    });

    const remainingUsage = await tx.businessProfile.aggregate({
      where: { userId: businessProfile.userId },
      _sum: {
        monthlyTokensUsed: true,
        monthlyCreditsUsed: true,
      },
    });

    await tx.user.update({
      where: { id: businessProfile.userId },
      data: {
        monthlyTokensUsed: remainingUsage._sum.monthlyTokensUsed || 0,
        monthlyCreditsUsed: remainingUsage._sum.monthlyCreditsUsed || 0,
      },
    });
  });

  clearQuotaCache(businessProfile.userId);
  res.status(200).json({ message: "Monthly usage reset to 0 successfully" });
};

export const updateBusinessUsage = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const { tokensUsed } = req.body;
  const businessProfileId = Number(id);

  const businessProfile = await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { monthlyTokensUsed: tokensUsed },
    select: { userId: true },
  });

  clearQuotaCache(businessProfile.userId);
  res
    .status(200)
    .json({ message: `Monthly tokens updated to ${tokensUsed}` });
};

export { registerAdmin, createManager };









