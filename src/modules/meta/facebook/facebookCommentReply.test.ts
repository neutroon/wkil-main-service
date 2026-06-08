import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  facebookPageFindFirst: vi.fn(),
}));

vi.mock("@config/env", () => ({
  env: {
    NODE_ENV: "test",
    FB_API_URL: "https://graph.facebook.com/v25.0",
    FB_APP_ID: "app_123",
    FB_APP_SECRET: "secret_123",
  },
}));

vi.mock("@config/prisma", () => ({
  default: {
    facebookPage: {
      findFirst: mocks.facebookPageFindFirst,
    },
  },
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: vi.fn((value: string) => `decrypted:${value}`),
  encryptFacebookSecret: vi.fn((value: string) => `encrypted:${value}`),
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
    getOrSet: vi.fn(),
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
    post: vi.fn(),
  },
}));

import { metaClient } from "@utils/apiClient";
import { replyToComment } from "./facebook.service";

const mockedMetaPost = metaClient.post as unknown as Mock;

describe("Facebook comment replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the selected page token before replying to a scoped comment", async () => {
    mocks.facebookPageFindFirst.mockResolvedValueOnce({
      pageAccessToken: "page_token",
      pageName: "Demo Page",
    });
    mockedMetaPost.mockResolvedValueOnce({ data: { id: "reply_1" } });

    const result = await replyToComment({
      commentId: "856714353987920_1257980976536939",
      pageId: "856714353987920",
      message: "yes",
    });

    expect(result).toEqual({ id: "reply_1" });
    expect(mocks.facebookPageFindFirst).toHaveBeenCalledWith({
      where: { pageId: "856714353987920", isActive: true },
      orderBy: { updatedAt: "desc" },
      select: { pageAccessToken: true, pageName: true },
    });
    expect(mockedMetaPost).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/856714353987920_1257980976536939/comments",
      {
        message: "yes",
        access_token: "decrypted:page_token",
      },
    );
  });
});
