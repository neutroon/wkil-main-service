import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "@config/env";

/**
 * CSRF Protection — Hardened Double-Submit Cookie Pattern.
 *
 * How it works (Production-Grade):
 * 1. `getCsrfToken`: The frontend "bootstraps" by calling this endpoint. 
 *    The backend returns a random token in the JSON body AND sets it in a 
 *    Secure, HttpOnly cookie.
 * 2. `validateCsrfToken`: On every state-mutating request, the frontend sends 
 *    the token in the `X-CSRF-Token` header. The backend compares it 
 *    to the HttpOnly cookie.
 *
 * Security Benefit: Even if an attacker succeeds with XSS, they cannot 
 * read the HttpOnly cookie, making it significantly harder to forge 
 * valid CSRF-protected requests.
 */

const CSRF_COOKIE_NAME = "csrfToken";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const getCookieOptions = (req: Request) => {
  const isProduction = env.NODE_ENV === "production";
  const isTunnel = env.BACKEND_URL?.includes("ngrok-free.dev") || false;
  
  return {
    httpOnly: true, // Hardened: Cookie is hidden from JS
    secure: isProduction || isTunnel,
    sameSite: (isProduction || isTunnel) ? "none" as const : "lax" as const,
    path: "/",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  };
};

export const generateCsrfToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!req.cookies?.[CSRF_COOKIE_NAME]) {
    const token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE_NAME, token, getCookieOptions(req));
  }
  next();
};

/**
 * Controller: getCsrfToken
 * Returns the current CSRF token (or generates one) in the response body.
 * Essential for cross-domain bootstrapping where the frontend cannot read the cookie directly.
 */
export const getCsrfToken = (req: Request, res: Response) => {
  let token = req.cookies?.[CSRF_COOKIE_NAME];
  
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE_NAME, token, getCookieOptions(req));
  }

  res.json({ csrfToken: token });
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
