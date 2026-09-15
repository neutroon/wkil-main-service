import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import cookieParser from "cookie-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/env", () => ({ env: { NODE_ENV: "production", JWT_SECRET: "test-access", JWT_REFRESH_SECRET: "test-refresh" } }));
vi.mock("@config/prisma", () => ({ default: { user: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@modules/mail/mail.service", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("@modules/auth/user/user.service", () => ({ getUserById: vi.fn() }));
vi.mock("@modules/auth/core/socialAuth.service", () => ({ verifyGoogleIdToken: vi.fn(), authenticateSocialUser: vi.fn() }));

import prisma from "@config/prisma";
import { errorHandler } from "@middlewares/errorHandler.middleware";
import { mobileRefresh, mobileLogout } from "./mobileAuth.controller";
import { extractRefreshToken } from "@modules/auth/core/auth.service";
const app = express();
app.use(express.json());
app.use(cookieParser());
app.post("/refresh", mobileRefresh);
app.post("/logout", mobileLogout);
app.use(errorHandler);
const token = jwt.sign({ id: 7 }, "test-refresh", { expiresIn: "1h" });
const hash = bcrypt.hashSync(token, 4);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 7, name: "Test", email: "test@example.com", role: "user", isSocialUser: true, isActive: true, refreshTokenHash: hash } as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
});

describe("mobile refresh credential transport", () => {
  it.each(["bearer", "json"])("rotates a valid %s refresh credential", async (source) => {
    const pending = request(app).post("/refresh");
    const response = source === "bearer" ? await pending.set("Authorization", `Bearer ${token}`) : await pending.send({ refreshToken: token });
    expect(response.status).toBe(200);
    expect(jwt.verify(response.body.accessToken, "test-access")).toMatchObject({ id: 7 });
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 } }));
  });

  it("preserves a usable JSON token when an unrelated bearer is also present", async () => {
    const response = await request(app).post("/refresh").set("Authorization", "Bearer invalid-header").send({ refreshToken: token });
    expect(response.status).toBe(200);
  });

  it("preserves legacy cookie precedence over a bearer header", async () => {
    const response = await request(app).post("/refresh")
      .set("Cookie", `refreshToken=${token}`)
      .set("Authorization", "Bearer invalid-header");
    expect(response.status).toBe(200);
  });

  it.each(["", "   ", 5])("accepts a bearer token when JSON has no usable string (%s)", async (refreshToken) => {
    const response = await request(app).post("/refresh")
      .set("Authorization", `bearer ${token}`).send({ refreshToken });
    expect(response.status).toBe(200);
  });

  it.each([undefined, "Basic test", "Bearer", "Bearer bad extra"])("rejects missing or malformed bearer %s", async (authorization) => {
    const pending = request(app).post("/refresh");
    if (authorization) pending.set("Authorization", authorization);
    const response = await pending.send({});
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("NO_REFRESH_TOKEN");
  });

  it.each(["bearer", "json"])("rejects an invalid %s refresh token", async (source) => {
    const pending = request(app).post("/refresh");
    const response = source === "bearer" ? await pending.set("Authorization", "Bearer invalid") : await pending.send({ refreshToken: "invalid" });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it.each(["bearer", "json"])("revokes a %s logout session", async (source) => {
    const pending = request(app).post("/logout");
    const response = source === "bearer" ? await pending.set("Authorization", `Bearer ${token}`) : await pending.send({ refreshToken: token });
    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 }, data: expect.objectContaining({ refreshTokenHash: null }) }));
  });

  it("keeps logout without a credential idempotent", async () => {
    expect((await request(app).post("/logout").send({})).status).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the shared web extractor body/cookie-only", () => {
    expect(extractRefreshToken({ headers: { authorization: "Bearer unrelated" }, cookies: { refreshToken: "cookie" } } as never)).toBe("cookie");
    expect(extractRefreshToken({ headers: { authorization: "Bearer unrelated" } } as never)).toBeNull();
  });
});
