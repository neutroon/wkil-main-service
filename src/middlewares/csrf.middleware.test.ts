import type { Request, Response, NextFunction } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/env", () => ({
  env: {
    NODE_ENV: "production",
    BACKEND_URL: undefined,
  },
}));

import { validateCsrfToken } from "./csrf.middleware";

function makeReq(overrides: {
  method?: string;
  authorization?: string;
  cookies?: Record<string, string>;
  csrfHeader?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (overrides.authorization !== undefined) {
    headers["authorization"] = overrides.authorization;
  }
  if (overrides.csrfHeader !== undefined) {
    headers["x-csrf-token"] = overrides.csrfHeader;
  }
  return {
    method: overrides.method ?? "POST",
    headers,
    cookies: overrides.cookies ?? {},
  } as unknown as Request;
}

function makeRes() {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as Response;
}

describe("validateCsrfToken", () => {
  let next: NextFunction;
  beforeEach(() => {
    next = vi.fn();
  });

  describe("safe methods", () => {
    it("passes through GET without any tokens", () => {
      const res = makeRes();
      validateCsrfToken(makeReq({ method: "GET" }), res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("passes through HEAD and OPTIONS", () => {
      for (const method of ["HEAD", "OPTIONS"]) {
        const res = makeRes();
        const nextInner = vi.fn();
        validateCsrfToken(makeReq({ method }), res, nextInner);
        expect(nextInner).toHaveBeenCalledOnce();
      }
    });
  });

  describe("cookie-based clients (web dashboard)", () => {
    it("rejects POST with no cookie and no header", () => {
      const res = makeRes();
      validateCsrfToken(makeReq({ method: "POST" }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "CSRF_TOKEN_MISSING" }),
      );
    });

    it("rejects POST with cookie but no header", () => {
      const res = makeRes();
      validateCsrfToken(
        makeReq({
          method: "POST",
          cookies: { csrfToken: "abc" },
        }),
        res,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("rejects POST with header but no cookie", () => {
      const res = makeRes();
      validateCsrfToken(
        makeReq({
          method: "POST",
          csrfHeader: "abc",
        }),
        res,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("rejects POST with mismatched tokens", () => {
      const res = makeRes();
      validateCsrfToken(
        makeReq({
          method: "POST",
          cookies: { csrfToken: "abc" },
          csrfHeader: "xyz",
        }),
        res,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "CSRF_TOKEN_INVALID" }),
      );
    });

    it("passes POST with matching cookie + header", () => {
      const res = makeRes();
      validateCsrfToken(
        makeReq({
          method: "POST",
          cookies: { csrfToken: "abc" },
          csrfHeader: "abc",
        }),
        res,
        next,
      );
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("Bearer-token clients (mobile / server-to-server)", () => {
    it("passes POST with Authorization: Bearer and no CSRF tokens at all", () => {
      const res = makeRes();
      validateCsrfToken(
        makeReq({
          method: "POST",
          authorization: "Bearer eyJhbGciOi...",
        }),
        res,
        next,
      );
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("is case-insensitive on the scheme (RFC 7235)", () => {
      const res = makeRes();
      const nextInner = vi.fn();
      validateCsrfToken(
        makeReq({
          method: "POST",
          authorization: "bearer eyJhbGciOi...",
        }),
        res,
        nextInner,
      );
      expect(nextInner).toHaveBeenCalledOnce();
    });

    it("tolerates extra whitespace after the scheme", () => {
      const res = makeRes();
      const nextInner = vi.fn();
      validateCsrfToken(
        makeReq({
          method: "POST",
          authorization: "Bearer    eyJhbGciOi...",
        }),
        res,
        nextInner,
      );
      expect(nextInner).toHaveBeenCalledOnce();
    });

    it("does NOT skip for non-Bearer Authorization schemes", () => {
      // A Basic-authenticated request still has the same browser
      // auto-attach problem as cookies, so CSRF must still apply.
      const res = makeRes();
      validateCsrfToken(
        makeReq({
          method: "POST",
          authorization: "Basic dXNlcjpwYXNz",
        }),
        res,
        next,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
