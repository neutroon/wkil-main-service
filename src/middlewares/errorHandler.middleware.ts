import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../utils/logger";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;

  constructor(message: string, statusCode: number, isOperational = true, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  // Log error
  logger.error(err.message, {
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  // Handle Zod Validation Errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      status: "fail",
      message: "Validation failed",
      errors: err.issues.map((e: any) => ({
        path: e.path.join("."),
        message: e.message,
      })),
    });
  }

  // Handle Prisma Errors (mark as operational to see messages)
  if (err.name?.startsWith("Prisma") || err.code?.startsWith("P")) {
    (err as any).isOperational = true;
    (err as any).statusCode = 400; // Most Prisma errors are bad requests/conflicts
  }

  if (process.env.NODE_ENV === "development") {
    res.status(err.statusCode).json({
      status: err.status,
      error: err,
      message: err.message,
      code: err.code,
      stack: err.stack,
    });
  } else {
    // Production: don't leak stack traces
    if (err.isOperational) {
      res.status(err.statusCode).json({
        status: err.status,
        message: err.message,
        code: err.code,
        ...err,
      });
    } else {
      // Programming or other unknown error: don't leak error details in production normally,
      // but during this migration we need to see what's happening.
      console.error("NON-OPERATIONAL ERROR:", err);
      res.status(500).json({
        status: "error",
        message: "Something went very wrong!",
        debug: {
          name: err.name,
          message: err.message,
          stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
        }
      });
    }
  }
};
