import express from "express";
import request from "supertest";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/env", () => ({ env: { NODE_ENV: "production", GOOGLE_AUTH_CLIENT_ID: "test-google-client" } }));
vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@config/prisma", () => ({ default: { socialIdentity: { findUnique: vi.fn() } } }));
vi.mock("@modules/auth/core/auth.service", async () => ({
  AppError: (await import("@middlewares/errorHandler.middleware")).AppError,
  issueAuthSession: vi.fn(), getMobileUserShape: vi.fn(), verifyCredentials: vi.fn(),
  validateAndRotateRefreshToken: vi.fn(), logoutAndRevoke: vi.fn(),
}));
vi.mock("@modules/auth/user/user.service", () => ({ getUserById: vi.fn() }));
vi.mock("@modules/auth/core/auth.middleware", () => ({ authenticateToken: vi.fn() }));
vi.mock("@middlewares/rateLimit.middleware", () => ({ authLimiter: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("@modules/workspace/workspace.service", () => ({ provisionWorkspaceForUser: vi.fn() }));

import prisma from "@config/prisma";
import { env } from "@config/env";
import { AppError, errorHandler } from "@middlewares/errorHandler.middleware";
import mobileAuthRoutes from "./mobileAuth.routes";

const app = express();
app.use(express.json());
app.use("/v1/mobile", mobileAuthRoutes);
app.use(errorHandler);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = encode({ alg: "RS256", kid: "test-key" });
const payload = encode({ iss: "https://accounts.google.com", aud: "test-google-client", exp: 4102444800, sub: "test-subject" });
const signed = `${header}.${payload}`;
const token = `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
const post = (credential: string) => request(app).post("/v1/mobile/auth/google").send({ token: credential });

beforeEach(() => {
  vi.clearAllMocks();
  env.GOOGLE_AUTH_CLIENT_ID = "test-google-client";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key" }] }) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("mobile Google production error boundary", () => {
  it("retains the stable Google configuration error", async () => {
    env.GOOGLE_AUTH_CLIENT_ID = "";
    const response = await post(token);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: "error", message: "Google auth is not configured", code: "GOOGLE_AUTH_NOT_CONFIGURED" });
  });

  it("retains the operational certificate-provider error", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    const response = await post(token);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ status: "error", message: "Unable to verify Google credential", code: "GOOGLE_CERTS_UNAVAILABLE" });
  });
  it("preserves request validation failures as 400 responses", async () => {
    const response = await request(app).post("/v1/mobile/auth/google").send({});
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ status: "fail", message: "Validation failed" });
    expect(response.body).not.toHaveProperty("debug");
  });
  it.each([
    "abc.def.ghi",
    `${header}.${Buffer.from("not-json").toString("base64url")}.sig`,
    `${encode(null)}.${payload}.sig`,
    `${header}.${encode(null)}.sig`,
    `${header}.${encode([])}.sig`,
  ])("returns a stable invalid-token response for malformed token %s", async (credential) => {
    const response = await post(credential);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ status: "error", message: "Invalid Google credential", code: "GOOGLE_TOKEN_INVALID" });
  });

  it("hides unexpected Google provider failure details", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("private provider connection details"));
    const response = await post(token);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: "error", message: "Unable to complete Google authentication", code: "GOOGLE_AUTH_FAILED" });
  });

  it("hides rejected persistence operations including Prisma metadata", async () => {
    vi.mocked(prisma.socialIdentity.findUnique).mockRejectedValue(Object.assign(new Error("private SQL and database host"), {
      name: "PrismaClientKnownRequestError", code: "P2021", meta: { table: "private_schema" }, clientVersion: "test",
    }));
    const response = await post(token);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: "error", message: "Unable to complete Google authentication", code: "GOOGLE_AUTH_FAILED" });
  });

  it("preserves approved operational auth codes without arbitrary attached metadata", async () => {
    vi.mocked(prisma.socialIdentity.findUnique).mockRejectedValue(Object.assign(
      new AppError("Account is inactive", 403, true, "ACCOUNT_INACTIVE"), { debug: "private details" },
    ));
    const response = await post(token);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ status: "error", message: "Account is inactive", code: "ACCOUNT_INACTIVE" });
  });
});
