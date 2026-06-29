import { z } from "zod";

/**
 * The mobile client POSTs to /v1/notifications/device-tokens with the
 * FCM registration token + the platform that issued it. The backend
 * stores the mapping `token -> userId` so we can fan out later.
 */
export const upsertDeviceTokenSchema = z.object({
  body: z.object({
    token: z.string().min(10, "Token is required").max(4096),
    platform: z.enum(["ios", "android"]),
  }),
});

export const deleteDeviceTokenSchema = z.object({
  body: z.object({
    token: z.string().min(10).max(4096),
  }),
});

export type UpsertDeviceTokenBody = z.infer<
  typeof upsertDeviceTokenSchema
>["body"];
export type DeleteDeviceTokenBody = z.infer<
  typeof deleteDeviceTokenSchema
>["body"];
