import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";

// ---------------------------------------------------------------------------
// JWT payload shape expected from the API gateway
// ---------------------------------------------------------------------------

const jwtPayloadSchema = z.object({
  sub:        z.string().min(1),
  customerId: z.string().uuid(),
  email:      z.string().email().optional(),
  iat:        z.number().optional(),
  exp:        z.number().optional(),
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Validates the `Authorization: Bearer <token>` header.
 * On success sets `res.locals.auth` with the verified payload.
 * On failure returns a 401 with a machine-readable error code.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers["authorization"];

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing Bearer token" },
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const verifyOptions: jwt.VerifyOptions = {};
    if (env.JWT_AUDIENCE) verifyOptions.audience = env.JWT_AUDIENCE;
    if (env.JWT_ISSUER)   verifyOptions.issuer   = env.JWT_ISSUER;

    const decoded = jwt.verify(token, env.JWT_SECRET, verifyOptions);

    const parsed = jwtPayloadSchema.safeParse(decoded);
    if (!parsed.success) {
      res.status(401).json({
        error: { code: "TOKEN_INVALID", message: "Token payload is malformed" },
      });
      return;
    }

    res.locals["auth"] = {
      userId:     parsed.data.sub,
      customerId: parsed.data.customerId,
      email:      parsed.data.email,
    };

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        error: { code: "TOKEN_EXPIRED", message: "Token has expired" },
      });
    } else if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        error: { code: "TOKEN_INVALID", message: "Token signature is invalid" },
      });
    } else {
      res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication failed" },
      });
    }
  }
}
