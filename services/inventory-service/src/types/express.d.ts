import { PileRepository } from "../repositories/pileRepository";
import { InventorySnapshotRepository } from "../repositories/inventorySnapshotRepository";

export interface AuthPayload {
  /** Subject — internal user ID from the JWT `sub` claim. */
  userId:     string;
  /** Tenant UUID from the JWT `customerId` claim. */
  customerId: string;
  email?:     string;
}

declare global {
  namespace Express {
    interface Locals {
      /** Set by the authenticate middleware on every protected route. */
      auth:         AuthPayload;
      pileRepo:     PileRepository;
      snapshotRepo: InventorySnapshotRepository;
    }
  }
}
