import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "@config/env";

/**
 * CSRF Protection — Double-Submit Cookie Pattern (stateless, no DB required).
 *
 * How it works:
 * 1. `generateCsrfToken`: On every request, if no `csrfToken` cookie exists,
 *    set a new random token as a NON-HttpOnly cookie (readable by JS).
 * 2. `validateCsrfToken`: On every state-mutating request (POST/PUT/PATCH/DELETE),
 *    verify that the `X-CSRF-Token` request header matches the `csrfToken` cookie.
 *
 * An attacker's page can trigger a cross-site request with the victim's HttpOnly
 * auth cookie, but cannot read the csrfToken cookie to forge the header.
 */

const CSRF_COOKIE_NAME = "csrfToken";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const generateCsrfToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!req.cookies?.[CSRF_COOKIE_NAME]) {
    const token = crypto.randomBytes(32).toString("hex");
    const isProduction = env.NODE_ENV === "production";
    const isTunnel = env.BACKEND_URL?.includes("ngrok-free.dev") || false;

    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false, // Must be readable by JS
      secure: isProduction || isTunnel,
      sameSite: (isProduction || isTunnel) ? "none" : "lax",
      path: "/",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
  }
  next();
};

export const validateCsrfToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Skip safe methods — they should never mutate state
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (!cookieToken || !headerToken) {
    return res.status(403).json({
      error: "CSRF token missing",
      code: "CSRF_TOKEN_MISSING",
    });
  }

  // Use timingSafeEqual to prevent timing attacks
  const cookieBuf = Buffer.from(cookieToken as string);
  const headerBuf = Buffer.from(headerToken as string);

  if (
    cookieBuf.length !== headerBuf.length ||
    !crypto.timingSafeEqual(cookieBuf, headerBuf)
  ) {
    return res.status(403).json({
      error: "CSRF token invalid",
      code: "CSRF_TOKEN_INVALID",
    });
  }

  next();
};
