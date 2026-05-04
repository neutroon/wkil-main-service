import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { env } from "@config/env";
const JWT_SECRET = env.JWT_SECRET;

/**
 * Middleware to populate req.user if a valid token is present.
 * Does NOT throw 401 if missing/invalid; used for rate-limit key generation.
 */
export const identifyUserForRateLimit = (req: any, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(" ")[1] || req.cookies?.accessToken;
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (decoded && typeof decoded === "object" && "id" in decoded) {
        req.user = { 
          id: decoded.id,
          role: decoded.role 
        };
      }
    }
  } catch (err) {
    // Silently ignore - we just want to identify the user if possible
  }
  next();
};

