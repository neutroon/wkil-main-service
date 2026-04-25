import { Request, Response, NextFunction } from "express";
import { ZodObject } from "zod";

/**
 * Zod Validation Middleware
 * Validates the request body, query, or params against a schema.
 */
export const validate = (schema: ZodObject<any>) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const validated = await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    req.body = validated.body;
    req.query = validated.query as any;
    req.params = validated.params as any;

    return next();
  };
};
