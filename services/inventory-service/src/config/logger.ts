import winston from "winston";
import { env } from "./env";

const { combine, timestamp, errors, json, colorize, simple } = winston.format;

// ---------------------------------------------------------------------------
// Transport: pretty-print in dev, structured JSON in production
// ---------------------------------------------------------------------------

const devTransport = new winston.transports.Console({
  format: combine(colorize(), simple()),
});

const prodTransport = new winston.transports.Console({
  format: combine(
    timestamp(),
    errors({ stack: true }),
    json(),
  ),
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  defaultMeta: { service: "inventory-service" },
  transports: [env.NODE_ENV === "production" ? prodTransport : devTransport],
  // Prevent unhandled promise rejections from crashing the process silently
  exitOnError: false,
});
