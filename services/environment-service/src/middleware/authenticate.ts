import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";

const jwtPayloadSchema = z.object({
  sub:        z.string(),
  customerId: z.string().uuid(),
  email:      z.string().email().optional(),
});

const verifyOptions: jwt.VerifyOptions = {
  algorithms: ["HS256"],
  ...(env.JWT_AUDIENCE && { audience: env.JWT_AUDIENCE }),
  ...(env.JWT_ISSUER   && { issuer:   env.JWT_ISSUER   }),
};

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: { code: "MISSING_TOKEN", message: "Authorization: Bearer <token> required" },
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, verifyOptions);
    const parsed  = jwtPayloadSchema.safeParse(decoded);

    if (!parsed.success) {
      res.status(401).json({
        error: { code: "TOKEN_MISSING_CLAIMS", message: "Token missing required claims" },
      });
      return;
    }

    res.locals["auth"] = {
      userId:     parsed.data.sub,
      customerId: parsed.data.customerId,
      email:      parsed.data.email ?? null,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: { code: "TOKEN_EXPIRED", message: "Token has expired" } });
    } else {
      res.status(401).json({ error: { code: "TOKEN_INVALID", message: "Token is invalid" } });
    }
  }
}
