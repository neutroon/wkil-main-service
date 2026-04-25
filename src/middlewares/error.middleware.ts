import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { ApiError } from "../utils/apiError";

/**
 * Global Error Handler Middleware
 * Intercepts all errors thrown in the application and returns 
 * a standardized JSON response.
 */
export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const isDev = process.env.NODE_ENV === "development";
  
  // Determine status and message
  const status = err instanceof ApiError ? err.status : (err.status || 500);
  const message = err.message || "Internal Server Error";

  // Log the error centrally
  logger.error("api_error_handler", {
    status,
    message,
    path: req.path,
    method: req.method,
    // Only log stack traces in development or for 500 errors
    stack: (isDev || status === 500) ? err.stack : undefined,
  });

  // Standardized error response
  res.status(status).json({
    error: message,
    // Provide stack trace only in development for easier debugging
    ...(isDev && { stack: err.stack }),
  });
};
