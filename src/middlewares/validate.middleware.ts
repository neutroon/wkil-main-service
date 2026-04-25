import { Request, Response, NextFunction } from "express";
import { ZodObject } from "zod";

/**
 * Zod Validation Middleware
 * Uses Generics to maintain type safety throughout the request lifecycle.
 */
export const validate = <T extends ZodObject<any>>(schema: T) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // 1. Validate the request
    const validated = await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    // 2. Map validated data back to the request using defineProperty 
    // to bypass read-only getters in Express 5 (like req.query and req.params)
    Object.keys(validated).forEach((key) => {
      Object.defineProperty(req, key, {
        value: (validated as any)[key],
        writable: true,
        configurable: true,
        enumerable: true,
      });
    });

    return next();
  };
};
