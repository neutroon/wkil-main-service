import fs from "fs";
import os from "os";
import path from "path";
import { env } from "@config/env";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

/**
 * Bootstraps the firebase-admin SDK from a base64-encoded service
 * account JSON, exactly once per process.
 *
 * Production Fly.io / Codemagic flow:
 *   1. Operator base64-encodes the Firebase service account JSON.
 *   2. Sets it as `FIREBASE_SERVICE_ACCOUNT_BASE64` in secrets.
 *   3. On boot we decode to a tempfile, set
 *      `GOOGLE_APPLICATION_CREDENTIALS` to that path, and let
 *      `firebase-admin` pick it up via Application Default Credentials.
 *
 * Local dev: same as prod, or run `gcloud auth application-default login`
 * and point `GOOGLE_APPLICATION_CREDENTIALS` at a real key file.
 *
 * Disabled mode (FCM_ENABLED=false or env var missing): all push calls
 * log a warning and resolve to a no-op result so the rest of the
 * handoff pipeline keeps working in CI / tests.
 */

// We use a narrow, hand-rolled type for what we use from firebase-admin
// rather than importing the full types. firebase-admin's `.d.ts` is large
// and pulls `lighthouse` types we don't need. This keeps the surface we
// rely on explicit and stable.
type AdminMessaging = {
  sendEachForMulticast: (
    message: MulticastMessagePayload,
  ) => Promise<MulticastResponse>;
};

type MulticastMessagePayload = {
  tokens: string[];
  notification: { title: string; body: string };
  data: Record<string, string>;
  android?: Record<string, unknown>;
  apns?: Record<string, unknown>;
};

type MulticastResponse = {
  successCount: number;
  failureCount: number;
  responses: Array<{
    success: boolean;
    error?: { code?: string; message?: string };
  }>;
};

type AdminModule = {
  initializeApp: (opts: { projectId?: string }) => unknown;
  messaging: (app?: unknown) => AdminMessaging;
};

let adminModule: AdminModule | null = null;
let messaging: AdminMessaging | null = null;
let initialized = false;
let tmpCredentialPath: string | null = null;

function decodeBase64ServiceAccount(): string | null {
  const b64 = env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, "base64").toString("utf-8");
    // Sanity-check it's JSON. firebase-admin will throw a friendlier
    // error than "ENOENT: no such file" if we hand it garbage.
    JSON.parse(json);
    return json;
  } catch (err) {
    logger.error("fcm.service_account_decode_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function materializeCredentialFile(): string | null {
  const json = decodeBase64ServiceAccount();
  if (!json) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wkil-fcm-"));
  const filePath = path.join(dir, "service-account.json");
  fs.writeFileSync(filePath, json, { mode: 0o600 });
  // Wipe on process exit. Best-effort — Fly instances restart cleanly.
  process.once("exit", () => {
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(dir);
    } catch {
      // ignore
    }
  });
  return filePath;
}

export function isFcmEnabled(): boolean {
  return initialized && messaging !== null;
}

/**
 * Initialize firebase-admin exactly once. Idempotent.
 * Returns true if FCM is ready, false if disabled / unconfigured.
 */
export async function initFcm(): Promise<boolean> {
  if (initialized) return isFcmEnabled();
  initialized = true; // prevent retry storms

  if (!env.FCM_ENABLED) {
    logger.info("fcm.disabled_by_config", { reason: "FCM_ENABLED=false" });
    return false;
  }

  // Lazy import: firebase-admin is a heavy dep; only load when actually
  // needed so unit tests that never touch FCM don't pay the cost.
  try {
    adminModule = (await import("firebase-admin")) as unknown as AdminModule;
  } catch (err) {
    logger.error("fcm.import_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  // Credential resolution order (matters in production!):
  //   1. FIREBASE_SERVICE_ACCOUNT_BASE64 — the operator-provided
  //      base64 blob. ALWAYS preferred on serverless/container
  //      deployments because the production container won't have
  //      the developer's local JSON file. The Dockerfile doesn't
  //      ship secrets; they come in via Fly secrets / env vars.
  //   2. GOOGLE_APPLICATION_CREDENTIALS — a path to a JSON file
  //      on disk. Useful for local dev (`gcloud auth
  //      application-default login` writes one to a known path).
  //      NOT preferred for serverless because the file path
  //      configured in one env (e.g. Vertex AI's
  //      `google-cloud-key.json`) almost certainly won't exist
  //      in the container.
  //
  // The base64 path is preferred even if GOOGLE_APPLICATION_CREDENTIALS
  // is also set. Otherwise a leftover local-dev path silently
  // shadows the real secret and the resulting
  // `app/invalid-credential` error is hard to diagnose from the
  // handoff pipeline's logs.
  if (env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const tmp = materializeCredentialFile();
    if (tmp) {
      tmpCredentialPath = tmp;
      // Override whatever GOOGLE_APPLICATION_CREDENTIALS pointed at.
      // firebase-admin's `applicationDefault()` looks at this env var
      // and we want it to read the freshly-materialized file, not
      // the stale local path.
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
    }
  }
  // If FIREBASE_SERVICE_ACCOUNT_BASE64 is not set, leave
  // GOOGLE_APPLICATION_CREDENTIALS untouched and let
  // firebase-admin use whatever's there (typical in local dev).

  if (!env.FIREBASE_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    logger.error("fcm.init_failed", {
      reason: "FIREBASE_PROJECT_ID and GOOGLE_CLOUD_PROJECT_ID both empty",
    });
    return false;
  }

  try {
    const app = adminModule.initializeApp({
      projectId: env.FIREBASE_PROJECT_ID,
    });
    messaging = adminModule.messaging(app);
    logger.info("fcm.initialized", { projectId: env.FIREBASE_PROJECT_ID });
    return true;
  } catch (err) {
    logger.error("fcm.init_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    adminModule = null;
    messaging = null;
    return false;
  }
}

export type MulticastResult = {
  attempted: number;
  successCount: number;
  failureCount: number;
  /** Tokens that returned an unrecoverable error and should be deleted server-side. */
  deadTokens: string[];
};

/**
 * Send a single message to up to 500 FCM tokens. For larger lists, splits
 * into 500-token batches and sends sequentially.
 *
 * Returns counts and the list of dead tokens. NEVER throws — FCM outages
 * must not affect the handoff decision.
 */
export async function sendMulticast(params: {
  tokens: string[];
  notification: { title: string; body: string };
  data: Record<string, string>;
  android?: {
    channelId?: string;
    priority?: "normal" | "high";
    visibility?: "public" | "private" | "secret";
  };
  apns?: {
    /** Maps to apns-push-type header. Required for modern iOS. */
    pushType?:
      | "alert"
      | "background"
      | "voip"
      | "complication"
      | "fileprovider"
      | "liveactivity";
    category?: string;
    sound?: string;
    mutableContent?: boolean;
  };
}): Promise<MulticastResult> {
  if (!isFcmEnabled() || !messaging || params.tokens.length === 0) {
    return { attempted: 0, successCount: 0, failureCount: 0, deadTokens: [] };
  }

  // FCM only allows 500 tokens per multicast call.
  const batches: string[][] = [];
  for (let i = 0; i < params.tokens.length; i += 500) {
    batches.push(params.tokens.slice(i, i + 500));
  }

  let successCount = 0;
  let failureCount = 0;
  const deadTokens: string[] = [];

  for (const batch of batches) {
    try {
      const message = buildMessage(params, batch);
      const resp = await messaging.sendEachForMulticast(message);
      successCount += resp.successCount;
      failureCount += resp.failureCount;
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code ?? "";
          // Codes that mean "this token is gone for good" — see
          // https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token" ||
            code === "messaging/invalid-argument"
          ) {
            deadTokens.push(batch[idx]);
          }
        }
      });
    } catch (err) {
      // Whole-batch failure (network blip, quota). Don't kill the handoff.
      logger.error("fcm.send_batch_failed", {
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      failureCount += batch.length;
    }
  }

  return {
    attempted: params.tokens.length,
    successCount,
    failureCount,
    deadTokens,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildMessage(
  params: Parameters<typeof sendMulticast>[0],
  tokens: string[],
): MulticastMessagePayload {
  return {
    tokens,
    notification: {
      title: params.notification.title,
      body: params.notification.body,
    },
    data: params.data,
    // Field names MUST match the FCM HTTP v1 API spec at
    // https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
    // The firebase-admin SDK accepts camelCase but only for fields that
    // exist in the v1 spec under those names. The `defaultVibrateTimers`
    // and `category` fields some old blog posts recommend DO NOT EXIST
    // in v1 and cause `messaging/invalid-argument` rejections.
    android: {
      priority: (params.android?.priority ?? "high").toUpperCase(),
      notification: {
        // `channelId` (camelCase) maps to `channel_id` in v1. The
        // SDK handles the conversion for known fields.
        channelId: params.android?.channelId ?? "handoff_requests",
        // `visibility` is a v1 enum: PUBLIC | PRIVATE | SECRET.
        visibility: (params.android?.visibility ?? "public").toUpperCase(),
        // `default_sound` in v1 — a boolean. Tells FCM to use the
        // channel's default sound instead of an override.
        defaultSound: true,
        // `default_vibrate_timings` in v1 — a boolean. Tells FCM
        // to use the channel's default vibration pattern.
        defaultVibrateTimings: true,
        // No `category` here — Android notification categorization
        // is done on the channel, not per-message. The channel
        // `handoff_requests` is already set to Importance.max
        // which gives it messaging-style heads-up behavior.
      },
    },
    apns: {
      headers: {
        "apns-push-type": params.apns?.pushType ?? "alert",
        "apns-priority": "10",
      },
      payload: {
        aps: {
          alert: {
            title: params.notification.title,
            body: params.notification.body,
          },
          sound: params.apns?.sound ?? "default",
          // `category` is valid on `aps` for iOS notification
          // actions. Reserved for v2 handoff action buttons.
          ...(params.apns?.category
            ? { category: params.apns.category }
            : {}),
          ...(params.apns?.mutableContent
            ? { "mutable-content": 1 }
            : {}),
        },
      },
    },
  };
}

/**
 * Clean up the tempfile on graceful shutdown (best-effort).
 * Exposed for server.ts to call on SIGTERM.
 */
export function shutdownFcm(): void {
  if (tmpCredentialPath) {
    try {
      fs.unlinkSync(tmpCredentialPath);
    } catch {
      // ignore
    }
    tmpCredentialPath = null;
  }
}

/**
 * Used by tests to inject a mock messaging client. Production code never
 * calls this.
 */
export function __setMessagingForTests(
  mock: AdminMessaging | null,
  enabled = true,
): void {
  messaging = mock;
  initialized = enabled;
}

/**
 * Get the configured messaging client, or throw a typed error if FCM
 * is not configured in this environment. Use at call sites that
 * genuinely cannot tolerate the no-op fallback (e.g. a "test
 * notification" admin button that should fail loudly when FCM is off).
 */
export function getMessagingOrThrow(): AdminMessaging {
  if (!isFcmEnabled() || !messaging) {
    throw new AppError("FCM is not configured in this environment", 503);
  }
  return messaging;
}
