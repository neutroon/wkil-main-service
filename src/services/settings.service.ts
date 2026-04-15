import prisma from "../config/prisma";
import { logger } from "../utils/logger";

import { DEFAULT_BILLING_MULTIPLIER } from "../config/billing";

const SETTINGS_CACHE: Record<string, { value: string; expiresAt: number }> = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const getSystemSetting = async (key: string, defaultValue: string): Promise<string> => {
  try {
    const cached = SETTINGS_CACHE[key];
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const setting = await prisma.systemSetting.findUnique({
      where: { key }
    });

    const value = setting ? setting.value : defaultValue;
    
    // Update cache with TTL
    SETTINGS_CACHE[key] = {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS
    };
    
    return value;
  } catch (error: any) {
    logger.error(`Failed to fetch system setting: ${key}`, { error: error.message });
    return defaultValue;
  }
};

export const updateSystemSetting = async (key: string, value: string): Promise<void> => {
  try {
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value }
    });

    // Update cache with TTL
    SETTINGS_CACHE[key] = {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS
    };
    logger.info(`System setting updated: ${key}=${value}`);
  } catch (error: any) {
    logger.error(`Failed to update system setting: ${key}`, { error: error.message });
    throw error;
  }
};

export const getBillingMultiplier = async (): Promise<number> => {
  const value = await getSystemSetting("billing_multiplier", DEFAULT_BILLING_MULTIPLIER.toString());
  return parseFloat(value);
};

export const updateBillingMultiplier = async (multiplier: number): Promise<void> => {
  if (multiplier < 1) {
    throw new Error("Multiplier cannot be less than 1.0");
  }
  await updateSystemSetting("billing_multiplier", multiplier.toString());
};
