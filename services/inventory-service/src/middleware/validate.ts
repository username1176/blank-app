import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

type RequestSource = "body" | "query" | "params";

/**
 * Returns an Express middleware that validates `req[source]` against the given
 * Zod schema.  On success the parsed (and coerced) value replaces the original.
 * On failure the ZodError is forwarded to the global error handler, which maps
 * it to a 422 Unprocessable Entity response.
 */
function makeValidator(source: RequestSource) {
  return <T>(schema: ZodSchema<T>) =>
    (req: Request, _res: Response, next: NextFunction): void => {
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        next(result.error);
        return;
      }
      // Replace with the coerced / transformed value so downstream handlers
      // receive the correct types (e.g. string → number, string → Date).
      (req as Record<string, unknown>)[source] = result.data;
      next();
    };
}

export const validate = {
  body:   makeValidator("body"),
  query:  makeValidator("query"),
  params: makeValidator("params"),
};
