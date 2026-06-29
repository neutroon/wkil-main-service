import { Router } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  deleteDeviceTokenSchema,
  upsertDeviceTokenSchema,
} from "./notifications.validation";
import {
  deleteDeviceTokenController,
  upsertDeviceTokenController,
} from "./notifications.controller";

const notificationsRoutes = Router();

// All notification routes require an authenticated user — the
// device-token row is keyed by userId.
notificationsRoutes.post(
  "/device-tokens",
  authenticateToken,
  validate(upsertDeviceTokenSchema),
  upsertDeviceTokenController,
);

notificationsRoutes.delete(
  "/device-tokens",
  authenticateToken,
  validate(deleteDeviceTokenSchema),
  deleteDeviceTokenController,
);

export default notificationsRoutes;
