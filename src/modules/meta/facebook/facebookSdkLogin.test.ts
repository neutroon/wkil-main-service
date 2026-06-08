import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@config/env", () => ({
  env: {
    NODE_ENV: "test",
    FB_API_URL: "https://graph.facebook.com/v25.0",
    FB_APP_ID: "app_123",
    FB_APP_SECRET: "secret_123",
  },
}));

vi.mock("@config/prisma", () => ({
  default: {},
}));

vi.mock("@utils/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@utils/cache", () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../core/webhookCache.service", () => ({
  invalidateFacebookPageCache: vi.fn(),
  invalidateIdentityCache: vi.fn(),
}));

vi.mock("../core/meta.queue", () => ({
  createBullMqJobId: vi.fn(() => "job-id"),
  metaExpressQueue: {
    add: vi.fn(),
  },
}));

vi.mock("@sentry/node", () => ({
  captureMessage: vi.fn(),
}));

vi.mock("@utils/apiClient", () => ({
  metaClient: {
    get: vi.fn(),
  },
}));

import { metaClient } from "@utils/apiClient";
import { generateAuthUrl, prepareSdkFacebookToken } from "./facebook.service";

const mockedMetaGet = metaClient.get as unknown as Mock;

describe("Facebook SDK login token preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests page user content access during OAuth login", () => {
    const authUrl = generateAuthUrl({
      redirect_uri: "https://app.example.com/facebook/callback",
      state: "review-state",
    });

    const url = new URL(authUrl);
    const requestedScopes = url.searchParams.get("scope")?.split(",") || [];

    expect(requestedScopes).toContain("pages_read_user_content");
  });

  it("validates a SDK token and exchanges it for a long-lived token", async () => {
    mockedMetaGet
      .mockResolvedValueOnce({
        data: {
          data: {
            is_valid: true,
            app_id: "app_123",
            user_id: "fb_user_1",
            scopes: ["pages_show_list", "pages_manage_metadata"],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          access_token: "long_lived_token",
          token_type: "bearer",
          expires_in: 5_184_000,
        },
      });

    const token = await prepareSdkFacebookToken({
      accessToken: "short_lived_token",
      userId: "fb_user_1",
      expiresIn: 3600,
    });

    expect(token).toMatchObject({
      access_token: "long_lived_token",
      token_type: "bearer",
      expires_in: 5_184_000,
      scope: "pages_show_list,pages_manage_metadata",
    });
    expect(mockedMetaGet).toHaveBeenCalledTimes(2);
  });

  it("rejects tokens issued for a different app", async () => {
    mockedMetaGet.mockResolvedValueOnce({
      data: {
        data: {
          is_valid: true,
          app_id: "other_app",
          user_id: "fb_user_1",
        },
      },
    });

    await expect(
      prepareSdkFacebookToken({
        accessToken: "short_lived_token",
        userId: "fb_user_1",
      }),
    ).rejects.toThrow(/another app/i);
    expect(mockedMetaGet).toHaveBeenCalledTimes(1);
  });
});
