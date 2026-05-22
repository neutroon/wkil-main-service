import bcrypt from "bcrypt";
import { createVerify, randomBytes } from "crypto";
import prisma from "@config/prisma";
import { env } from "@config/env";
import { AppError } from "@middlewares/errorHandler.middleware";

export type SocialProvider = "google" | "facebook";

export type SocialProfile = {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  avatarUrl?: string | null;
};

type GoogleJwk = {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
};

type JwtHeader = {
  alg: string;
  kid?: string;
  typ?: string;
};

type GoogleIdTokenPayload = {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  exp: number;
};

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isEmailVerified: true,
  lastVerificationSentAt: true,
  isBusinessProfileCreated: true,
} as const;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const decodeBase64UrlJson = <T>(value: string): T => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as T;
};

const assertActiveUser = (user: { isActive: boolean } | null) => {
  if (!user) return;
  if (!user.isActive) {
    throw new AppError("Account is inactive", 403, true, "ACCOUNT_INACTIVE");
  }
};

export const authenticateSocialUser = async (
  provider: SocialProvider,
  profile: SocialProfile,
) => {
  if (!profile.providerUserId) {
    throw new AppError("Social provider user id is required", 400, true, "SOCIAL_ID_MISSING");
  }
  if (!profile.email) {
    throw new AppError("Social provider did not return an email address", 400, true, "SOCIAL_EMAIL_MISSING");
  }
  if (!profile.emailVerified) {
    throw new AppError("Social provider email is not verified", 400, true, "SOCIAL_EMAIL_UNVERIFIED");
  }

  const email = normalizeEmail(profile.email);

  const existingIdentity = await prisma.socialIdentity.findUnique({
    where: {
      provider_providerUserId: {
        provider,
        providerUserId: profile.providerUserId,
      },
    },
    include: {
      user: {
        select: {
          ...userSelect,
          isActive: true,
        },
      },
    },
  });

  if (existingIdentity) {
    assertActiveUser(existingIdentity.user);

    await prisma.socialIdentity.update({
      where: { id: existingIdentity.id },
      data: {
        email,
        name: profile.name || existingIdentity.name,
        avatarUrl: profile.avatarUrl || existingIdentity.avatarUrl,
      },
    });

    const { isActive: _isActive, ...user } = existingIdentity.user;
    return user;
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: {
      ...userSelect,
      isActive: true,
    },
  });

  assertActiveUser(existingUser);

  if (existingUser) {
    await prisma.socialIdentity.create({
      data: {
        provider,
        providerUserId: profile.providerUserId,
        email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        userId: existingUser.id,
      },
    });

    if (!existingUser.isEmailVerified) {
      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          isEmailVerified: true,
          emailVerificationToken: null,
        },
      });
    }

    const { isActive: _isActive, ...user } = {
      ...existingUser,
      isEmailVerified: true,
    };
    return user;
  }

  const randomPassword = randomBytes(48).toString("hex");
  const password = await bcrypt.hash(randomPassword, 10);
  const displayName = profile.name?.trim() || email.split("@")[0] || "PagesPilot User";

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: displayName,
        email,
        password,
        role: "user",
        isEmailVerified: true,
        emailVerificationToken: null,
      },
      select: userSelect,
    });

    await tx.socialIdentity.create({
      data: {
        provider,
        providerUserId: profile.providerUserId,
        email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        userId: user.id,
      },
    });

    return user;
  });
};

export const verifyGoogleIdToken = async (idToken: string): Promise<SocialProfile> => {
  if (!env.GOOGLE_AUTH_CLIENT_ID) {
    throw new AppError("Google auth is not configured", 500, true, "GOOGLE_AUTH_NOT_CONFIGURED");
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new AppError("Invalid Google credential", 401, true, "GOOGLE_TOKEN_INVALID");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeBase64UrlJson<JwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<GoogleIdTokenPayload>(encodedPayload);

  if (header.alg !== "RS256" || !header.kid) {
    throw new AppError("Invalid Google credential", 401, true, "GOOGLE_TOKEN_INVALID");
  }
  if (!GOOGLE_ISSUERS.has(payload.iss) || payload.aud !== env.GOOGLE_AUTH_CLIENT_ID) {
    throw new AppError("Invalid Google credential audience", 401, true, "GOOGLE_TOKEN_AUDIENCE_INVALID");
  }
  if (!payload.exp || payload.exp * 1000 <= Date.now()) {
    throw new AppError("Google credential has expired", 401, true, "GOOGLE_TOKEN_EXPIRED");
  }

  const jwksResponse = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!jwksResponse.ok) {
    throw new AppError("Unable to verify Google credential", 502, true, "GOOGLE_CERTS_UNAVAILABLE");
  }

  const jwks = (await jwksResponse.json()) as { keys: GoogleJwk[] };
  const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!key) {
    throw new AppError("Invalid Google credential", 401, true, "GOOGLE_TOKEN_INVALID");
  }

  const publicKey = createPublicKeyFromJwk(key);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();

  const signature = Buffer.from(
    encodedSignature.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );

  if (!verifier.verify(publicKey, signature)) {
    throw new AppError("Invalid Google credential signature", 401, true, "GOOGLE_TOKEN_INVALID");
  }

  return {
    providerUserId: payload.sub,
    email: payload.email || "",
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: payload.name,
    avatarUrl: payload.picture,
  };
};

const createPublicKeyFromJwk = (jwk: GoogleJwk) => {
  return {
    key: {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
    },
    format: "jwk" as const,
  };
};

export const verifyFacebookAccessToken = async (
  accessToken: string,
): Promise<SocialProfile> => {
  const facebookAuthAppId = env.FB_AUTH_APP_ID || env.FB_APP_ID;
  const facebookAuthAppSecret = env.FB_AUTH_APP_SECRET || env.FB_APP_SECRET;
  const appAccessToken = `${facebookAuthAppId}|${facebookAuthAppSecret}`;
  const graphBase = env.FB_API_URL.replace(/\/$/, "");

  const debugUrl = new URL(`${graphBase}/debug_token`);
  debugUrl.searchParams.set("input_token", accessToken);
  debugUrl.searchParams.set("access_token", appAccessToken);

  const debugResponse = await fetch(debugUrl);
  if (!debugResponse.ok) {
    throw new AppError("Unable to validate Facebook token", 502, true, "FACEBOOK_TOKEN_VALIDATION_FAILED");
  }

  const debugPayload = (await debugResponse.json()) as {
    data?: {
      app_id?: string;
      user_id?: string;
      is_valid?: boolean;
    };
  };

  const debugData = debugPayload.data;
  if (!debugData?.is_valid || debugData.app_id !== facebookAuthAppId || !debugData.user_id) {
    throw new AppError("Invalid Facebook credential", 401, true, "FACEBOOK_TOKEN_INVALID");
  }

  const profileUrl = new URL(`${graphBase}/me`);
  profileUrl.searchParams.set("fields", "id,name,email,picture");
  profileUrl.searchParams.set("access_token", accessToken);

  const profileResponse = await fetch(profileUrl);
  if (!profileResponse.ok) {
    throw new AppError("Unable to read Facebook profile", 502, true, "FACEBOOK_PROFILE_UNAVAILABLE");
  }

  const profile = (await profileResponse.json()) as {
    id?: string;
    name?: string;
    email?: string;
    picture?: {
      data?: {
        url?: string;
      };
    };
  };

  if (profile.id !== debugData.user_id) {
    throw new AppError("Facebook profile mismatch", 401, true, "FACEBOOK_PROFILE_MISMATCH");
  }

  return {
    providerUserId: profile.id || "",
    email: profile.email || "",
    emailVerified: Boolean(profile.email),
    name: profile.name,
    avatarUrl: profile.picture?.data?.url,
  };
};
