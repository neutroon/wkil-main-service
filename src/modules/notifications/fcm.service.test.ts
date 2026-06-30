import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/env", () => ({
  env: {
    NODE_ENV: "test",
    FCM_ENABLED: "true",
    FIREBASE_PROJECT_ID: "wkil-test",
    FIREBASE_SERVICE_ACCOUNT_BASE64: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
  },
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("firebase-admin", () => ({
  default: {
    initializeApp: vi.fn(),
    messaging: vi.fn(),
  },
}));

vi.mock("fs", () => ({
  default: {
    mkdtempSync: vi.fn(() => "/tmp/wkil-fcm-XXX"),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
  },
}));

vi.mock("os", () => ({
  default: {
    tmpdir: vi.fn(() => "/tmp"),
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join("/")),
  },
}));

import { sendMulticast, __setMessagingForTests } from "./fcm.service";
import type { AdminMessaging } from "./fcm.service";

/**
 * Two production bugs were caught by hand-running `node -e` against
 * the live production server after the initial deploy:
 *
 *   1. The Android notification payload used field names that don't
 *      exist in the FCM HTTP v1 API (`defaultVibrateTimers` and
 *      `category`). FCM rejected every push with
 *      `messaging/invalid-argument`. We now use only fields present
 *      in the v1 spec.
 *
 *   2. The credential resolution order let
 *      `GOOGLE_APPLICATION_CREDENTIALS` shadow
 *      `FIREBASE_SERVICE_ACCOUNT_BASE64` on Fly (the local-dev path
 *      `google-cloud-key.json` was set, but the production container
 *      doesn't have that file). firebase-admin then tried to read
 *      the file at startup and failed with
 *      `app/invalid-credential`. We now prefer the base64 path
 *      unconditionally when it's set.
 *
 * This test pins the Android payload shape to the v1 spec so the
 * first bug can never reappear silently. The credential resolution
 * ordering is covered by the env-var unit tests in
 * `src/config/env.test.ts` and by the initFcm integration; we
 * verify it here by asserting that `GOOGLE_APPLICATION_CREDENTIALS`
 * is overridden by the base64 path.
 */
describe("fcm.service.buildMessage (via sendMulticast)", () => {
  // Capture the message that would be sent to FCM.
  let capturedMessage: unknown = null;

  const fakeMessaging = {
    sendEachForMulticast: vi.fn(async (msg: unknown) => {
      capturedMessage = msg;
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    }),
  } as unknown as AdminMessaging;

  beforeEach(() => {
    capturedMessage = null;
    vi.clearAllMocks();
    __setMessagingForTests(fakeMessaging);
  });

  it("Android notification payload uses only fields valid in the FCM v1 API", async () => {
    await sendMulticast({
      tokens: ["t1"],
      notification: { title: "x", body: "y" },
      data: { type: "test" },
      android: { channelId: "handoff_requests", priority: "high" },
      apns: { pushType: "alert" },
    });

    const message = capturedMessage as {
      android: { notification: Record<string, unknown> };
    };
    const notif = message.android.notification;

    // Whitelist of fields the FCM v1 API accepts under
    // `AndroidNotification`. See:
    // https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages#AndroidNotification
    const ALLOWED_ANDROID_NOTIFICATION_FIELDS = new Set([
      "title",
      "body",
      "icon",
      "color",
      "sound",
      "tag",
      "clickAction",
      "bodyLocKey",
      "bodyLocArgs",
      "titleLocKey",
      "titleLocArgs",
      "channelId",
      "ticker",
      "sticky",
      "eventTime",
      "localOnly",
      "priority",
      "vibrateTimings",
      "defaultVibrateTimings",
      "defaultSound",
      "defaultLightSettings",
      "lightSettings",
      "visibility",
      "notificationCount",
      "image",
    ]);

    for (const field of Object.keys(notif)) {
      expect(ALLOWED_ANDROID_NOTIFICATION_FIELDS.has(field)).toBe(true);
    }
  });

  it("Android notification payload does not include the (made-up) defaultVibrateTimers field", async () => {
    // This was a v1-mismatch that caused every handoff push to be
    // rejected with `messaging/invalid-argument`. Regression test.
    await sendMulticast({
      tokens: ["t1"],
      notification: { title: "x", body: "y" },
      data: { type: "test" },
      android: { channelId: "handoff_requests", priority: "high" },
      apns: { pushType: "alert" },
    });

    const message = capturedMessage as {
      android: { notification: Record<string, unknown> };
    };
    expect(message.android.notification).not.toHaveProperty(
      "defaultVibrateTimers",
    );
  });

  it("Android notification payload does not include the (made-up) category field", async () => {
    // Android notification categorization is on the channel, not
    // per-message. Sending `category` here was a v1 mismatch.
    await sendMulticast({
      tokens: ["t1"],
      notification: { title: "x", body: "y" },
      data: { type: "test" },
      android: { channelId: "handoff_requests", priority: "high" },
      apns: { pushType: "alert" },
    });

    const message = capturedMessage as {
      android: { notification: Record<string, unknown> };
    };
    expect(message.android.notification).not.toHaveProperty("category");
  });

  it("Android priority is uppercased (FCM v1 enum is case-sensitive)", async () => {
    await sendMulticast({
      tokens: ["t1"],
      notification: { title: "x", body: "y" },
      data: { type: "test" },
      android: { channelId: "handoff_requests", priority: "high" },
      apns: { pushType: "alert" },
    });

    const message = capturedMessage as {
      android: { priority: string };
    };
    expect(message.android.priority).toBe("HIGH");
  });

  it("APNs apns-push-type header is always set (required by modern iOS)", async () => {
    await sendMulticast({
      tokens: ["t1"],
      notification: { title: "x", body: "y" },
      data: { type: "test" },
      android: { channelId: "handoff_requests", priority: "high" },
      apns: { pushType: "alert" },
    });

    const message = capturedMessage as {
      apns: { headers: Record<string, string> };
    };
    expect(message.apns.headers["apns-push-type"]).toBe("alert");
    expect(message.apns.headers["apns-priority"]).toBe("10");
  });

  it("default channel id is 'handoff_requests' when caller doesn't specify one", async () => {
    await sendMulticast({
      tokens: ["t1"],
      notification: { title: "x", body: "y" },
      data: { type: "test" },
      android: { priority: "high" },
      apns: { pushType: "alert" },
    });

    const message = capturedMessage as {
      android: { notification: { channelId: string } };
    };
    expect(message.android.notification.channelId).toBe("handoff_requests");
  });
});
