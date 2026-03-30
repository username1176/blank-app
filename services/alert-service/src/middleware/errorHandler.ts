import { ErrorRequestHandler, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = "ERROR",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code:        "VALIDATION_ERROR",
        message:     "Request validation failed",
        fieldErrors: err.flatten().fieldErrors,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  logger.error("Unhandled error", { error: err });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
};
