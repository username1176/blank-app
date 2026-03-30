import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";

// ---------------------------------------------------------------------------
// Typed application error
// ---------------------------------------------------------------------------

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ---------------------------------------------------------------------------
// Error response shape
// ---------------------------------------------------------------------------

interface ErrorResponse {
  error: {
    code:    string;
    message: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Global error handler middleware
// ---------------------------------------------------------------------------

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // Zod validation error → 422 Unprocessable Entity
  if (err instanceof ZodError) {
    const body: ErrorResponse = {
      error: {
        code:    "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.flatten().fieldErrors,
      },
    };
    res.status(422).json(body);
    return;
  }

  // Known application error
  if (err instanceof AppError) {
    const body: ErrorResponse = {
      error: {
        code:    err.code ?? "APP_ERROR",
        message: err.message,
      },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Unexpected error — log full details, return generic 500
  logger.error("Unhandled error", {
    error:  err instanceof Error ? err.message : String(err),
    stack:  err instanceof Error ? err.stack   : undefined,
    method: req.method,
    path:   req.path,
  });

  const body: ErrorResponse = {
    error: {
      code:    "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  };
  res.status(500).json(body);
}
