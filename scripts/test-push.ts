/**
 * Test harness for the FCM push pipeline.
 *
 * This script exercises the EXACT production code path:
 *   1. Initializes firebase-admin the same way server.ts does
 *   2. Reads active device tokens the same way handoffPush.service.ts does
 *   3. Calls sendMulticast() with the same payload shape
 *
 * It is a one-off CLI tool, not an HTTP endpoint, so there's no
 * attack surface to expose. Designed to be deleted once the FCM
 * integration is verified end-to-end.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/test-push.ts --list
 *     Show every DeviceToken row in the database.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/test-push.ts --token <fcmToken>
 *     Send a test push to one specific token. Use this when you
 *     have a token from `flutter logs` but no matching DB row
 *     (e.g. upload failed because the CSRF fix wasn't deployed yet).
 *
 *   npx ts-node -r tsconfig-paths/register scripts/test-push.ts --user <userId>
 *     Send a test push to every active device belonging to one user.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/test-push.ts --business <businessProfileId>
 *     Send a test push to every active device of every user
 *     who owns this business. This is what the handoff pipeline
 *     actually does.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/test-push.ts --user-businesses <userId>
 *     Print every business profile owned by the given user, with
 *     token counts. Use this to find the right `--business` id
 *     before running the handoff simulation.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/test-push.ts --status
 *     One-shot diagnostic: FCM init status, total token count,
 *     total user count with at least one token, total business
 *     profile count. Use this when "the handoff push doesn't
 *     arrive" — it tells us whether the problem is on the FCM
 *     side or the data side.
 *
 * The script exits 0 on success, 1 on any error. Dead tokens
 * (FCM reported them as unregistered) are printed and the
 * corresponding DB rows are deleted — exactly like the
 * production handoff pipeline does.
 *
 * Required env (set via the same secrets as production):
 *   FCM_ENABLED=true
 *   FIREBASE_SERVICE_ACCOUNT_BASE64=<base64 service-account JSON>
 *   FIREBASE_PROJECT_ID=<firebase project id>
 */
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import {
  deleteDeviceTokens,
  listActiveTokensForBusiness,
  listActiveTokensForUser,
} from "@modules/notifications/deviceToken.service";
import { initFcm, isFcmEnabled, sendMulticast } from "@modules/notifications/fcm.service";
import { env } from "@config/env";

type Mode =
  | "list"
  | "status"
  | "user-businesses"
  | "token"
  | "user"
  | "business";

interface CliArgs {
  mode: Mode;
  target: string | number;
}

function parseArgs(argv: string[]): CliArgs {
  // Drop the first two args (node, script path). Tolerate `npm run`
  // style invocations that pass extra flags first.
  const args = argv.slice(2);

  const flag = args[0];
  const value = args[1];

  if (flag === "--list") {
    return { mode: "list", target: "" };
  }
  if (flag === "--status") {
    return { mode: "status", target: "" };
  }
  if (flag === "--user-businesses" && value) {
    const id = Number.parseInt(value, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `--user-businesses expects a positive integer, got: ${value}`,
      );
    }
    return { mode: "user-businesses", target: id };
  }
  if (flag === "--token" && value) {
    return { mode: "token", target: value };
  }
  if (flag === "--user" && value) {
    const id = Number.parseInt(value, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`--user expects a positive integer, got: ${value}`);
    }
    return { mode: "user", target: id };
  }
  if (flag === "--business" && value) {
    const id = Number.parseInt(value, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `--business expects a positive integer, got: ${value}`,
      );
    }
    return { mode: "business", target: id };
  }

  throw new Error(
    "Usage: test-push --list | --status | --user-businesses <userId> | " +
      "--token <fcmToken> | --user <userId> | --business <businessProfileId>",
  );
}

async function listTokens(): Promise<void> {
  const rows = await prisma.deviceToken.findMany({
    orderBy: { lastSeenAt: "desc" },
    include: {
      user: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (rows.length === 0) {
    logger.info("test_push.list.empty", {});
    return;
  }

  logger.info("test_push.list.count", { count: rows.length });
  for (const row of rows) {
    const ageMin = Math.round(
      (Date.now() - row.lastSeenAt.getTime()) / 60_000,
    );
    // Log the full token — this is an operator tool, not a runtime
    // code path. Operators need the token to paste into the
    // Firebase Console when the script can't reach FCM.
    logger.info("test_push.list.row", {
      id: row.id,
      userId: row.userId,
      userName: row.user.name,
      userEmail: row.user.email,
      platform: row.platform,
      lastSeenAt: row.lastSeenAt.toISOString(),
      ageMin,
      token: row.token,
    });
  }
}

async function printStatus(): Promise<void> {
  // Try to initialize FCM. If it fails (or is disabled), the rest
  // of the diagnostic still runs and tells the operator exactly
  // what to fix.
  await initFcm();

  const [tokenCount, userCount, businessCount] = await Promise.all([
    prisma.deviceToken.count(),
    prisma.user.count({ where: { deviceTokens: { some: {} } } }),
    prisma.businessProfile.count(),
  ]);

  const usersById = await prisma.user.findMany({
    where: { deviceTokens: { some: {} } },
    select: {
      id: true,
      name: true,
      email: true,
      _count: {
        select: { deviceTokens: true, businessProfiles: true },
      },
    },
    orderBy: { id: "asc" },
  });

  logger.info("test_push.status", {
    fcmEnabled: isFcmEnabled(),
    fcmEnabledEnv: env.FCM_ENABLED,
    firebaseProjectIdConfigured: Boolean(env.FIREBASE_PROJECT_ID),
    serviceAccountBase64Configured: Boolean(env.FIREBASE_SERVICE_ACCOUNT_BASE64),
    totalDeviceTokens: tokenCount,
    totalUsersWithTokens: userCount,
    totalBusinessProfiles: businessCount,
    usersWithTokens: usersById.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      tokenCount: u._count.deviceTokens,
      businessCount: u._count.businessProfiles,
    })),
  });
}

async function listBusinessesForUser(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      businessProfiles: {
        select: {
          id: true,
          name: true,
          _count: { select: { conversations: true } },
        },
        orderBy: { id: "asc" },
      },
      _count: { select: { deviceTokens: true },
      },
    },
  });
  if (!user) {
    logger.error("test_push.user_not_found", { userId });
    process.exitCode = 1;
    return;
  }
  const tokenCountByBusiness = await Promise.all(
    user.businessProfiles.map(async (b) => {
      const tokens = await listActiveTokensForBusiness({
        businessProfileId: b.id,
      });
      return { businessId: b.id, name: b.name, activeTokenCount: tokens.length };
    }),
  );
  logger.info("test_push.user_businesses", {
    userId,
    userName: user.name,
    userEmail: user.email,
    userDeviceTokenCount: user._count.deviceTokens,
    businesses: tokenCountByBusiness,
  });
}

async function sendToTokens(
  tokens: string[],
  reason: string,
): Promise<void> {
  if (tokens.length === 0) {
    logger.warn("test_push.no_recipients", { reason });
    return;
  }

  const result = await sendMulticast({
    tokens,
    notification: {
      title: "wkil test push",
      body: "If you can read this on the device, the FCM pipeline works.",
    },
    data: {
      type: "test_push",
      sent_at: new Date().toISOString(),
      reason,
    },
    android: {
      channelId: "handoff_requests",
      priority: "high",
      visibility: "public",
    },
    apns: {
      pushType: "alert",
      sound: "default",
    },
  });

  logger.info("test_push.result", {
    reason,
    attempted: result.attempted,
    success: result.successCount,
    failed: result.failureCount,
    deadTokens: result.deadTokens.length,
  });

  if (result.deadTokens.length > 0) {
    const removed = await deleteDeviceTokens(result.deadTokens);
    logger.info("test_push.dead_tokens_cleaned", { removed });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.mode === "list") {
    await listTokens();
    return;
  }

  if (args.mode === "status") {
    await printStatus();
    return;
  }

  if (args.mode === "user-businesses") {
    await listBusinessesForUser(args.target as number);
    return;
  }

  // For any send mode, FCM must be configured. Fail fast with a
  // clear error rather than silently no-op'ing.
  await initFcm();
  if (!isFcmEnabled()) {
    logger.error("test_push.fcm_disabled", {
      hint: "Set FCM_ENABLED=true and FIREBASE_SERVICE_ACCOUNT_BASE64",
    });
    process.exitCode = 1;
    return;
  }

  switch (args.mode) {
    case "token":
      await sendToTokens([String(args.target)], "manual-token");
      return;
    case "user":
      const userId = args.target as number;
      const userRows = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      });
      if (!userRows) {
        logger.error("test_push.user_not_found", { userId });
        process.exitCode = 1;
        return;
      }
      const userTokens = await listActiveTokensForUser({ userId });
      logger.info("test_push.resolved_user", {
        userId,
        userName: userRows.name,
        tokenCount: userTokens.length,
      });
      await sendToTokens(userTokens, `user-${userId}`);
      return;
    case "business":
      const businessId = args.target as number;
      const businessTokens = await listActiveTokensForBusiness({
        businessProfileId: businessId,
      });
      logger.info("test_push.resolved_business", {
        businessId,
        tokenCount: businessTokens.length,
      });
      await sendToTokens(businessTokens, `business-${businessId}`);
      return;
  }
}

main()
  .catch((err: unknown) => {
    logger.error("test_push.unhandled", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
