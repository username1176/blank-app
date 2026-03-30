/**
 * Gateway-specific extensions to Express's Request and Locals types.
 */

declare global {
  namespace Express {
    interface Locals {
      /** Set by requestId middleware — echoed in X-Request-Id response header. */
      requestId: string;
      /** High-resolution start time for latency calculation. */
      startAt: bigint;
      /** Set by authenticate middleware when JWT_VERIFY_AT_GATEWAY=true. */
      auth?: {
        customerId: string;
        userId:     string;
        email:      string | null;
      };
    }
  }
}

export {};
