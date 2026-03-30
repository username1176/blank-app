/**
 * Service route definitions.
 *
 * Each entry maps an Express mount path prefix to a backend service.
 * The order matters: Express matches the first route whose prefix fits,
 * so more specific prefixes should come before more general ones — though
 * in this gateway each service owns a distinct prefix so order is cosmetic.
 *
 * Rate limiters are attached per route so each service can have an
 * independent quota on top of the global limiter applied in app.ts.
 */

import { Router } from "express";
import { createServiceProxy } from "./factory";
import {
  inventoryLimiter,
  moistureLimiter,
  environmentLimiter,
  alertsLimiter,
} from "../middleware/rateLimiter";
import { env } from "../config/env";

export function attachProxyRoutes(router: Router): void {
  // ── Inventory service ────────────────────────────────────────────────────────
  router.use(
    "/api/inventory",
    inventoryLimiter,
    createServiceProxy({
      name:       "inventory",
      target:     env.INVENTORY_SERVICE_URL,
      pathPrefix: "/api/inventory",
    }),
  );

  // ── Moisture service ─────────────────────────────────────────────────────────
  router.use(
    "/api/moisture",
    moistureLimiter,
    createServiceProxy({
      name:       "moisture",
      target:     env.MOISTURE_SERVICE_URL,
      pathPrefix: "/api/moisture",
    }),
  );

  // ── Environment service ──────────────────────────────────────────────────────
  router.use(
    "/api/environment",
    environmentLimiter,
    createServiceProxy({
      name:       "environment",
      target:     env.ENVIRONMENT_SERVICE_URL,
      pathPrefix: "/api/environment",
    }),
  );

  // ── Alert service ────────────────────────────────────────────────────────────
  router.use(
    "/api/alerts",
    alertsLimiter,
    createServiceProxy({
      name:       "alerts",
      target:     env.ALERT_SERVICE_URL,
      pathPrefix: "/api/alerts",
    }),
  );
}
