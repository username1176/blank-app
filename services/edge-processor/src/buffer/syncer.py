"""
BufferSyncer — drains the offline buffer when cloud services are reachable.

Connectivity check
------------------
Before dequeuing, the syncer sends a lightweight GET to each service's
`/health/live` endpoint.  A response of any status < 500 (or even a 404,
which proves the network path is open) is treated as "reachable".  Only
genuine network-layer failures (ConnectError, TimeoutError) count as
"unreachable".

This keeps the check cheap: no retries, 5 s timeout, single call per service.

Sync loop
---------
1. Check moisture-service reachability.
2. Check inventory-service reachability.
3. Dequeue up to `batch_size` pending rows in FIFO order.
4. For each entry:
     a. Reconstruct the original HTTP request from the stored payload.
     b. POST/PUT to the appropriate service.
     c. On 2xx → mark_synced().
     d. On non-2xx or exception → mark_failed() (returns to 'pending'
        unless attempts == max_attempts, in which case 'failed').
5. After the batch, run `store.prune()` to clean up old done/failed rows.

Partial connectivity
--------------------
If only one of the two services is reachable, the syncer still processes
the batch but skips entries whose target service is known-down.  Those
entries are immediately released back to 'pending' (reset without
incrementing the attempt counter) so they are re-tried next cycle.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Optional

import httpx

from ..api.client import ApiClient
from .store import BufferedEntry, BufferStore

logger = logging.getLogger(__name__)


@dataclass
class SyncResult:
    """Summary of a single sync pass."""
    skipped: bool = False      # True when both services unreachable
    synced: int = 0
    failed: int = 0
    released: int = 0          # returned to 'pending' (service was down)
    entries_seen: int = 0

    @property
    def attempted(self) -> int:
        return self.synced + self.failed + self.released


class BufferSyncer:
    """
    Drains the offline buffer in FIFO order.

    Parameters
    ----------
    store
        The `BufferStore` to read from / update.
    moisture_client
        `ApiClient` pointed at moisture-service.
    inventory_client
        `ApiClient` pointed at inventory-service.
    batch_size
        Maximum rows to process per sync invocation.
    max_attempts
        After this many failures, an entry is permanently marked 'failed'.
    connectivity_timeout_s
        Timeout for the lightweight /health/live ping (seconds).
    """

    def __init__(
        self,
        store: BufferStore,
        moisture_client: ApiClient,
        inventory_client: ApiClient,
        *,
        batch_size: int = 50,
        max_attempts: int = 5,
        connectivity_timeout_s: float = 5.0,
    ) -> None:
        self._store = store
        self._moisture = moisture_client
        self._inventory = inventory_client
        self._batch_size = batch_size
        self._max_attempts = max_attempts
        self._connectivity_timeout_s = connectivity_timeout_s

    # ── Public ────────────────────────────────────────────────────────────────

    async def check_connectivity(self) -> dict[str, Optional[bool]]:
        """
        Probe both services and return a reachability dict.

        Values are True (up), False (down), or None if the check itself
        failed unexpectedly.
        """
        moisture_up, inventory_up = await asyncio.gather(
            self._is_reachable(self._moisture,  "moisture-service"),
            self._is_reachable(self._inventory, "inventory-service"),
            return_exceptions=True,
        )
        return {
            "moisture_service":  moisture_up  if isinstance(moisture_up,  bool) else None,
            "inventory_service": inventory_up if isinstance(inventory_up, bool) else None,
        }

    async def sync_pending(self) -> SyncResult:
        """
        Run one sync pass.  Safe to call from any async context — never raises.
        """
        loop = asyncio.get_running_loop()

        # Quick-check connectivity for both services (run concurrently)
        moisture_up, inventory_up = await asyncio.gather(
            self._is_reachable(self._moisture, "moisture-service"),
            self._is_reachable(self._inventory, "inventory-service"),
        )

        if not moisture_up and not inventory_up:
            logger.debug("Both services unreachable — skipping sync")
            return SyncResult(skipped=True)

        logger.info(
            "Connectivity check",
            extra={"moisture_up": moisture_up, "inventory_up": inventory_up},
        )

        # Load a batch from the buffer (runs sqlite in thread pool)
        entries: list[BufferedEntry] = await loop.run_in_executor(
            None, lambda: self._store.dequeue_pending(self._batch_size)
        )

        if not entries:
            logger.debug("No pending buffer entries to sync")
            return SyncResult()

        logger.info(
            "Syncing buffered entries",
            extra={"count": len(entries), "batch_size": self._batch_size},
        )

        result = SyncResult(entries_seen=len(entries))

        for entry in entries:
            service_up = moisture_up if entry.upload_type == "moisture" else inventory_up

            if not service_up:
                # Release back to 'pending' without incrementing attempt counter
                await loop.run_in_executor(
                    None, lambda e=entry: self._release_to_pending(e.row_id)
                )
                result.released += 1
                continue

            try:
                ok, status_code = await self._upload_entry(entry)
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                logger.warning(
                    "Buffer entry upload raised exception",
                    extra={"id": entry.row_id, "type": entry.upload_type, "error": error},
                )
                await loop.run_in_executor(
                    None,
                    lambda e=entry, err=error: self._store.mark_failed(
                        e.row_id, err, self._max_attempts
                    ),
                )
                result.failed += 1
                continue

            if ok:
                await loop.run_in_executor(
                    None, lambda e=entry: self._store.mark_synced(e.row_id)
                )
                result.synced += 1
                logger.debug(
                    "Buffer entry synced",
                    extra={"id": entry.row_id, "type": entry.upload_type, "http": status_code},
                )
            else:
                error = f"HTTP {status_code}"
                await loop.run_in_executor(
                    None,
                    lambda e=entry, err=error: self._store.mark_failed(
                        e.row_id, err, self._max_attempts
                    ),
                )
                result.failed += 1
                logger.warning(
                    "Buffer entry sync returned non-2xx",
                    extra={"id": entry.row_id, "type": entry.upload_type, "status": status_code},
                )

        # Prune old done/failed rows (non-critical; run in background thread)
        asyncio.get_event_loop().run_in_executor(None, self._store.prune)

        logger.info(
            "Sync pass complete",
            extra={
                "synced":   result.synced,
                "failed":   result.failed,
                "released": result.released,
            },
        )
        return result

    # ── Private ───────────────────────────────────────────────────────────────

    async def _upload_entry(self, entry: BufferedEntry) -> tuple[bool, int]:
        """
        Reconstruct and execute the original HTTP request.

        Returns (success: bool, http_status_code: int).
        Raises on network-layer errors (caller catches).
        """
        if entry.upload_type == "moisture":
            return await self._upload_moisture(entry)
        if entry.upload_type == "inventory":
            return await self._upload_inventory(entry)
        raise ValueError(f"Unknown upload_type: {entry.upload_type!r}")

    async def _upload_moisture(self, entry: BufferedEntry) -> tuple[bool, int]:
        """Replay a buffered POST /predict multipart request."""
        if not entry.thermal_jpeg:
            # Without the image the request would fail; mark permanently done
            logger.warning(
                "Buffer entry missing thermal_jpeg — discarding",
                extra={"id": entry.row_id},
            )
            return True, 200  # treat as success so it's removed

        meta = json.loads(entry.payload_json)
        files = {
            "image": ("thermal.jpg", entry.thermal_jpeg, "image/jpeg")
        }
        data: dict[str, str] = {
            "pile_id": entry.pile_id,
            "site_id": entry.site_id,
        }
        if meta.get("camera_id"):
            data["camera_id"] = meta["camera_id"]
        if meta.get("sensor_readings"):
            data["sensor_readings"] = meta["sensor_readings"]

        resp = await self._moisture.post_multipart("/predict", files=files, data=data)
        return 200 <= resp.status_code < 300, resp.status_code

    async def _upload_inventory(self, entry: BufferedEntry) -> tuple[bool, int]:
        """Replay a buffered PUT /piles/:id/volume JSON request."""
        body = json.loads(entry.payload_json)
        path = f"/piles/{entry.pile_id}/volume"
        resp = await self._inventory.put_json(path, body)
        return 200 <= resp.status_code < 300, resp.status_code

    async def _is_reachable(self, client: ApiClient, service_name: str) -> bool:
        """
        Probe the service's /health/live endpoint.

        Returns True if any HTTP response is received (even 4xx proves the
        network path works).  Returns False only on network-layer errors.
        """
        url = f"{client._base_url}/health/live"
        try:
            async with httpx.AsyncClient(
                headers={"Authorization": f"Bearer {client._headers.get('Authorization', '')}"},
                timeout=httpx.Timeout(self._connectivity_timeout_s),
            ) as http:
                r = await http.get(url)
                reachable = r.status_code < 500
                if not reachable:
                    logger.debug(
                        "Service health check returned server error",
                        extra={"service": service_name, "status": r.status_code},
                    )
                return reachable
        except (httpx.ConnectError, httpx.TimeoutException, httpx.RemoteProtocolError) as exc:
            logger.debug(
                "Service unreachable",
                extra={"service": service_name, "error": str(exc)},
            )
            return False

    def _release_to_pending(self, row_id: int) -> None:
        """Reset a 'syncing' row back to 'pending' without incrementing attempts."""
        self._store._conn.execute(  # type: ignore[union-attr]
            "UPDATE pending_uploads SET status='pending' WHERE id=? AND status='syncing'",
            (row_id,),
        )
