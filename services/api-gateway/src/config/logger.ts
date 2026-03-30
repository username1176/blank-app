import { createLogger, format, transports } from "winston";
import { env } from "./env";

const { combine, timestamp, json, colorize, simple } = format;

const devFormat = combine(
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  simple(),
);

const prodFormat = combine(
  timestamp(),
  json(),
);

export const logger = createLogger({
  level:      env.LOG_LEVEL,
  format:     env.NODE_ENV === "development" ? devFormat : prodFormat,
  transports: [new transports.Console()],
  // Silence winston's own exception/rejection handlers — server.ts handles these
  exitOnError: false,
});
