/**
 * Terminal error handlers.
 *
 * notFound  — catches requests that fell through every route; returns 404.
 * errorHandler — Express 4-argument error middleware; returns 500 (or
 *               re-uses an existing status code if the error carries one).
 *
 * Both return JSON so clients always get a machine-readable error body.
 */

import { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { logger } from "../config/logger";

export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code:    "NOT_FOUND",
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
}

// Express recognises error middleware by its arity (4 params).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const status =
    typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;

  const message =
    err instanceof Error
      ? err.message
      : "An unexpected error occurred";

  if (status >= 500) {
    logger.error("Unhandled gateway error", { err });
  }

  res.status(status).json({
    error: {
      code:    status === 500 ? "INTERNAL_SERVER_ERROR" : "GATEWAY_ERROR",
      message,
    },
  });
};
