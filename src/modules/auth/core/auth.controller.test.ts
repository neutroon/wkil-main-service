import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.service", () => ({
  issueAuthSession: vi.fn(),
}));

vi.mock("./socialAuth.service", () => ({
  verifyGoogleIdToken: vi.fn(),
  verifyFacebookAccessToken: vi.fn(),
  authenticateSocialUser: vi.fn(),
}));

import * as authService from "./auth.service";
import {
  authenticateSocialUser,
  verifyFacebookAccessToken,
  verifyGoogleIdToken,
} from "./socialAuth.service";
import { facebookSocialAuth, googleSocialAuth } from "./auth.controller";

const user = {
  id: 9,
  name: "Social User",
  email: "social@example.com",
  role: "user",
  isEmailVerified: true,
  lastVerificationSentAt: null,
  isBusinessProfileCreated: false,
  isSocialUser: false,
  avatar: null,
};

const createResponse = () => {
  const res: any = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

describe("social auth controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateSocialUser).mockResolvedValue(user);
    vi.mocked(authService.issueAuthSession).mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
    });
  });

  it("verifies Google token, issues auth cookies, and returns the auth user", async () => {
    const profile = {
      providerUserId: "google-1",
      email: "social@example.com",
      emailVerified: true,
    };
    vi.mocked(verifyGoogleIdToken).mockResolvedValue(profile);
    const req: any = { body: { token: "google-token" } };
    const res = createResponse();

    await googleSocialAuth(req, res);

    expect(verifyGoogleIdToken).toHaveBeenCalledWith("google-token");
    expect(authenticateSocialUser).toHaveBeenCalledWith("google", profile);
    expect(authService.issueAuthSession).toHaveBeenCalledWith(res, user);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: "Social authentication successful",
      user,
    });
  });

  it("verifies Facebook token, issues auth cookies, and returns the auth user", async () => {
    const profile = {
      providerUserId: "facebook-1",
      email: "social@example.com",
      emailVerified: true,
    };
    vi.mocked(verifyFacebookAccessToken).mockResolvedValue(profile);
    const req: any = { body: { token: "facebook-token" } };
    const res = createResponse();

    await facebookSocialAuth(req, res);

    expect(verifyFacebookAccessToken).toHaveBeenCalledWith("facebook-token");
    expect(authenticateSocialUser).toHaveBeenCalledWith("facebook", profile);
    expect(authService.issueAuthSession).toHaveBeenCalledWith(res, user);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
