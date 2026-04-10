import prisma from "../config/prisma";
import { logger } from "../utils/logger";

import { DEFAULT_BILLING_MULTIPLIER } from "../config/billing";

const SETTINGS_CACHE: Record<string, any> = {};

export const getSystemSetting = async (key: string, defaultValue: string): Promise<string> => {
  try {
    // Return from cache if available
    if (SETTINGS_CACHE[key]) {
      return SETTINGS_CACHE[key];
    }

    const setting = await prisma.systemSetting.findUnique({
      where: { key }
    });

    const value = setting ? setting.value : defaultValue;
    SETTINGS_CACHE[key] = value;
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

    // Update cache
    SETTINGS_CACHE[key] = value;
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
