"""
API key authentication for the management REST API.

Clients must supply a secret key in either:
  X-API-Key: <key>
  Authorization: Bearer <key>

`X-API-Key` takes precedence.  The comparison uses `hmac.compare_digest`
to prevent timing-side-channel attacks against the key value.

Usage (FastAPI dependency injection):
    @router.get("/something")
    async def endpoint(_: None = Depends(require_api_key)):
        ...
"""

from __future__ import annotations

import hmac
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyHeader

_KEY_HEADER = APIKeyHeader(name="X-API-Key", auto_error=False)


def _extract_key(request: Request, header_key: Optional[str]) -> Optional[str]:
    """Return the API key from X-API-Key or Authorization: Bearer."""
    if header_key:
        return header_key
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer "):]
    return None


async def require_api_key(
    request: Request,
    header_key: Optional[str] = Depends(_KEY_HEADER),
) -> None:
    """
    FastAPI dependency that rejects requests with missing or wrong API keys.

    Raises 401 when no key is provided, 403 when the key is wrong.
    The distinction helps clients diagnose misconfiguration vs. wrong key.
    """
    supplied = _extract_key(request, header_key)
    if not supplied:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key required (X-API-Key header or Authorization: Bearer <key>)",
            headers={"WWW-Authenticate": "ApiKey"},
        )

    expected: str = request.app.state.ctx.settings.mgmt_api_key

    # Timing-safe comparison — prevents key enumeration via response timing
    if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid API key",
        )
