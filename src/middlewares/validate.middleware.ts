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

    // 2. Map validated data back to the request.
    // We cast the whole request to 'any' just for the assignment to avoid
    // Express's rigid internal type constraints (like ParamsDictionary),
    // but the local 'validated' variable remains fully typed.
    Object.assign(req, validated);

    return next();
  };
};
