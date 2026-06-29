import { Request, Response } from "express";
import {
  deleteDeviceToken,
  upsertDeviceToken,
} from "./deviceToken.service";
import type {
  DeleteDeviceTokenBody,
  UpsertDeviceTokenBody,
} from "./notifications.validation";

/**
 * POST /v1/notifications/device-tokens
 *
 * Mobile client calls this on cold start (with the current FCM token)
 * and on every `onTokenRefresh`. Upserts the (userId, token) row so
 * the next handoff push lands on this device.
 */
export const upsertDeviceTokenController = async (
  req: Request,
  res: Response,
) => {
  const user = (req as any).user as { id: number } | undefined;
  if (!user?.id) {
    // authenticateToken middleware guarantees this, but the type
    // assertion above narrows to optional; be explicit.
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  const body = req.body as UpsertDeviceTokenBody;
  await upsertDeviceToken({
    userId: user.id,
    token: body.token,
    platform: body.platform,
  });
  res.json({ success: true });
};

/**
 * DELETE /v1/notifications/device-tokens
 *
 * Mobile client calls this on logout so a lost / sold phone stops
 * receiving handoff alerts. Idempotent — no error if the token
 * wasn't registered.
 */
export const deleteDeviceTokenController = async (
  req: Request,
  res: Response,
) => {
  const user = (req as any).user as { id: number } | undefined;
  if (!user?.id) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  const body = req.body as DeleteDeviceTokenBody;
  await deleteDeviceToken({ userId: user.id, token: body.token });
  res.json({ success: true });
};
