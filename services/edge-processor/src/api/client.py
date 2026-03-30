"""
Async HTTP client with JWT auth and exponential-backoff retries.

Wraps `httpx.AsyncClient` with:
  - `Authorization: Bearer <token>` on every request
  - Exponential backoff on 429, 500, 502, 503, 504 and network errors
  - Configurable timeout and max-retry count
  - Structured logging on every attempt and final outcome
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import httpx

from ..config.settings import Settings

logger = logging.getLogger(__name__)

# HTTP status codes that are safe to retry
_RETRYABLE_STATUSES = {429, 500, 502, 503, 504}


class ApiClient:
    """
    Async HTTP client for backend service APIs.

    Parameters
    ----------
    settings
        Application settings (used for JWT, timeouts, retry config).
    base_url
        Service root URL, e.g. ``http://moisture-service:8000``.
    """

    def __init__(self, settings: Settings, base_url: str) -> None:
        self._s = settings
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {settings.api_jwt_token}",
        }

    @property
    def base_url(self) -> str:
        return self._base_url

    @base_url.setter
    def base_url(self, url: str) -> None:
        self._base_url = url.rstrip("/")

    # ── JSON requests ─────────────────────────────────────────────────────────

    async def put_json(self, path: str, body: dict) -> httpx.Response:
        """PUT *body* as JSON to *path* with retries."""
        return await self._request_with_retry("PUT", path, json=body)

    async def post_json(self, path: str, body: dict) -> httpx.Response:
        """POST *body* as JSON to *path* with retries."""
        return await self._request_with_retry("POST", path, json=body)

    # ── Multipart requests ────────────────────────────────────────────────────

    async def post_multipart(
        self,
        path: str,
        files: dict[str, Any],
        data: Optional[dict[str, str]] = None,
    ) -> httpx.Response:
        """
        POST a multipart/form-data request with retries.

        Parameters
        ----------
        path
            URL path (appended to base_url).
        files
            Dict of ``{field_name: (filename, bytes_content, mime_type)}``.
        data
            Additional form fields as strings.
        """
        return await self._request_with_retry("POST", path, files=files, data=data or {})

    # ── Core retry loop ───────────────────────────────────────────────────────

    async def _request_with_retry(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> httpx.Response:
        url = f"{self._base_url}{path}"
        max_retries = self._s.api_max_retries
        delay = self._s.api_retry_initial_delay_s
        last_exc: Optional[Exception] = None

        for attempt in range(max_retries + 1):
            try:
                resp = await self._send(method, url, **kwargs)

                if resp.status_code < 400:
                    if attempt > 0:
                        logger.info(
                            "Request succeeded after retry",
                            extra={"method": method, "url": url, "attempt": attempt},
                        )
                    return resp

                if resp.status_code not in _RETRYABLE_STATUSES:
                    # 4xx errors (except 429) are not retriable
                    logger.error(
                        "API returned non-retriable error",
                        extra={
                            "method":   method,
                            "url":      url,
                            "status":   resp.status_code,
                            "body":     resp.text[:300],
                        },
                    )
                    return resp

                logger.warning(
                    "API returned retriable status",
                    extra={
                        "method":   method,
                        "url":      url,
                        "status":   resp.status_code,
                        "attempt":  attempt,
                        "retries_left": max_retries - attempt,
                    },
                )

            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                last_exc = exc
                logger.warning(
                    "Network error during API request",
                    extra={
                        "method":       method,
                        "url":          url,
                        "error":        str(exc),
                        "attempt":      attempt,
                        "retries_left": max_retries - attempt,
                    },
                )

            if attempt < max_retries:
                await asyncio.sleep(delay)
                delay *= 2.0

        # All retries exhausted
        if last_exc:
            logger.error(
                "All retries exhausted — network error",
                extra={"method": method, "url": url, "error": str(last_exc)},
            )
            raise last_exc

        raise RuntimeError(f"All {max_retries} retries exhausted for {method} {url}")

    async def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Single HTTP attempt with timeout."""
        timeout = httpx.Timeout(self._s.api_timeout_s)
        async with httpx.AsyncClient(headers=self._headers, timeout=timeout) as client:
            return await client.request(method, url, **kwargs)
