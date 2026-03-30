/**
 * Proxy factory.
 *
 * Creates an http-proxy-middleware v3 handler for a single upstream service.
 *
 * Path rewriting:
 *   Incoming:  /api/inventory/items          (public URL)
 *   Upstream:  /items                        (service URL)
 *   The prefix "/api/<service-name>" is stripped before forwarding.
 *
 * Request hooks (on.proxyReq):
 *   • Removes any stale identity headers that slipped past authenticate.ts
 *   • Copies the gateway-assigned X-Request-Id into the proxied request
 *   • Sets X-Forwarded-For / X-Forwarded-Host if not already present
 *
 * Response hooks (on.proxyRes):
 *   • Logs upstream status at DEBUG level (request logger covers the rest)
 *
 * Error hook (on.error):
 *   • Returns a JSON 502 so clients always get a structured error body
 */

import { createProxyMiddleware, Options } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import type { ClientRequest, IncomingMessage } from "http";
import { env } from "../config/env";
import { logger } from "../config/logger";

export interface ServiceProxyOptions {
  /** Display name used in log messages. */
  name:    string;
  /** Full URL of the upstream service, e.g. "http://inventory-service:3001". */
  target: string;
  /**
   * Path prefix to strip, e.g. "/api/inventory".
   * Requests to /api/inventory/items become /items upstream.
   */
  pathPrefix: string;
}

export function createServiceProxy(opts: ServiceProxyOptions): RequestHandler {
  const proxyOptions: Options = {
    target:         opts.target,
    changeOrigin:   true,
    proxyTimeout:   env.PROXY_TIMEOUT_MS,
    timeout:        env.PROXY_TIMEOUT_MS,

    // Strip the /api/<service> prefix before forwarding.
    pathRewrite: {
      [`^${opts.pathPrefix}`]: "",
    },

    on: {
      proxyReq: (proxyReq: ClientRequest, req: IncomingMessage) => {
        const expressReq = req as import("express").Request;

        // Paranoia: strip any remaining spoofed identity headers.
        proxyReq.removeHeader("x-customer-id");
        proxyReq.removeHeader("x-user-id");

        // Re-inject verified identity from locals (set by authenticate.ts).
        const auth = (expressReq.res?.locals as Record<string, unknown>)?.["auth"] as
          | { customerId: string; userId: string }
          | undefined;

        if (auth) {
          proxyReq.setHeader("X-Customer-Id", auth.customerId);
          proxyReq.setHeader("X-User-Id",     auth.userId);
        }

        // Ensure request ID is forwarded.
        const requestId = (expressReq.res?.locals as Record<string, unknown>)?.["requestId"] as
          | string
          | undefined;
        if (requestId) {
          proxyReq.setHeader("X-Request-Id", requestId);
        }

        // Forward real client IP.
        if (!proxyReq.getHeader("X-Forwarded-For") && expressReq.ip) {
          proxyReq.setHeader("X-Forwarded-For", expressReq.ip);
        }
        if (!proxyReq.getHeader("X-Forwarded-Host") && expressReq.hostname) {
          proxyReq.setHeader("X-Forwarded-Host", expressReq.hostname);
        }
      },

      proxyRes: (proxyRes: IncomingMessage, req: IncomingMessage) => {
        const expressReq = req as import("express").Request;
        logger.debug("upstream response", {
          upstream: opts.name,
          method:   expressReq.method,
          path:     expressReq.path,
          status:   proxyRes.statusCode,
        });
      },

      error: (err: Error, req: IncomingMessage, res: unknown) => {
        const expressReq = req as import("express").Request;
        logger.error("Proxy error", { err, upstream: opts.name, path: expressReq.path });

        // res may be a Socket (WebSocket upgrade), skip JSON in that case.
        const expressRes = res as import("express").Response;
        if (typeof expressRes.status === "function") {
          const isTimeout =
            (err as NodeJS.ErrnoException).code === "ECONNRESET" ||
            err.message.includes("timeout");

          expressRes.status(isTimeout ? 504 : 502).json({
            error: {
              code:    isTimeout ? "UPSTREAM_TIMEOUT" : "BAD_GATEWAY",
              message: isTimeout
                ? `Upstream ${opts.name} timed out`
                : `Upstream ${opts.name} is unavailable`,
            },
          });
        }
      },
    },
  };

  return createProxyMiddleware(proxyOptions) as unknown as RequestHandler;
}
