import winston from "winston";
import { env } from "./env";

const { combine, timestamp, colorize, simple, json } = winston.format;

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  exitOnError: false,
  format:
    env.NODE_ENV === "production"
      ? combine(timestamp(), json())
      : combine(colorize(), timestamp({ format: "HH:mm:ss" }), simple()),
  transports: [new winston.transports.Console()],
});
