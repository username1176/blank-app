/**
 * Refresh token revocation store.
 *
 * Tracks revoked JWT IDs (jti claims) so refresh tokens cannot be reused
 * after rotation or explicit logout.  If a jti appears in this store, the
 * refresh is rejected even if the token signature and expiry are otherwise
 * valid.
 *
 * Implementation:
 *   In-memory Map keyed by jti, value = wall-clock expiry (ms since epoch).
 *   Entries are pruned lazily on every write so memory stays bounded by the
 *   number of active refresh tokens.
 *
 * Note on multi-replica deployments:
 *   This store is per-process.  For a horizontally-scaled gateway, replace
 *   with a Redis-backed implementation (SET jti 1 EX <ttl_sec> / EXISTS jti).
 *   The TokenStore interface is stable so the swap requires no route changes.
 */

export interface TokenStore {
  /** Mark a jti as revoked until its natural expiry. */
  revoke(jti: string, expiresAt: Date): void;
  /** Returns true if the jti has been explicitly revoked. */
  isRevoked(jti: string): boolean;
}

class InMemoryTokenStore implements TokenStore {
  /** jti → unix timestamp (ms) after which the entry is irrelevant */
  private readonly revoked = new Map<string, number>();

  revoke(jti: string, expiresAt: Date): void {
    this.revoked.set(jti, expiresAt.getTime());
    this._prune();
  }

  isRevoked(jti: string): boolean {
    const exp = this.revoked.get(jti);
    if (exp === undefined) return false;
    // Once the underlying token would have expired naturally, JWT verify
    // would reject it anyway — the revocation entry is no longer needed.
    if (Date.now() > exp) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }

  private _prune(): void {
    const now = Date.now();
    for (const [jti, exp] of this.revoked) {
      if (now > exp) this.revoked.delete(jti);
    }
  }
}

/** Singleton instance used by auth routes and the authenticate middleware. */
export const tokenStore: TokenStore = new InMemoryTokenStore();
