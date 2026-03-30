import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

type Source = "body" | "query" | "params";

function makeValidator(source: Source) {
  return <T>(schema: ZodSchema<T>) =>
    (req: Request, _res: Response, next: NextFunction): void => {
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        next(result.error);
        return;
      }
      (req as Record<string, unknown>)[source] = result.data;
      next();
    };
}

export const validate = {
  body:   makeValidator("body"),
  query:  makeValidator("query"),
  params: makeValidator("params"),
};
