"""
SQLite-backed offline buffer.

Stores API upload payloads locally when the cloud services are unreachable.
Entries are written atomically, replayed in FIFO order, and pruned once
successfully synced or permanently failed.

Schema (single table):
  pending_uploads — one row per buffered API call (moisture or inventory)

Thread safety:
  All public methods acquire a `threading.RLock` before touching the
  connection.  WAL journal mode allows concurrent readers while a write
  is in progress, giving the syncer clean reads even when the pipeline
  thread is inserting.

Buffer limits (enforced on every enqueue):
  max_rows   — max number of rows in 'pending' status.  Oldest entries are
               evicted (logged as warnings) when the limit is reached.
  max_size_mb — max total BLOB storage (thermal JPEGs).  Oldest thermal
                entries are evicted to stay under budget.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

_SCHEMA_SQL = """
PRAGMA journal_mode  = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;
PRAGMA auto_vacuum   = INCREMENTAL;

CREATE TABLE IF NOT EXISTS pending_uploads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_type     TEXT    NOT NULL,           -- 'moisture' | 'inventory'
    pile_id         TEXT    NOT NULL,
    site_id         TEXT    NOT NULL,
    captured_at     TEXT    NOT NULL,           -- ISO 8601 from pipeline
    payload_json    TEXT    NOT NULL,           -- metadata fields (JSON)
    thermal_jpeg    BLOB,                       -- NULL for inventory entries
    status          TEXT    NOT NULL DEFAULT 'pending',
                                                -- pending | syncing | done | failed
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error      TEXT,
    created_at      TEXT    NOT NULL,
    synced_at       TEXT
);

-- Partial index: only index rows that still need work, keeping index small
CREATE INDEX IF NOT EXISTS idx_pending_fifo
    ON pending_uploads (created_at ASC)
    WHERE status IN ('pending');

CREATE INDEX IF NOT EXISTS idx_syncing
    ON pending_uploads (id)
    WHERE status = 'syncing';
"""


@dataclass
class BufferedEntry:
    """In-memory representation of one buffered upload row."""
    upload_type: str                   # "moisture" | "inventory"
    pile_id: str
    site_id: str
    captured_at: str                   # ISO 8601
    payload_json: str                  # JSON-encoded metadata or request body
    thermal_jpeg: Optional[bytes] = None
    # Populated when loaded from DB
    row_id: Optional[int] = None
    attempts: int = 0
    last_error: Optional[str] = None


@dataclass
class BufferStats:
    pending_count: int
    syncing_count: int
    done_count: int
    failed_count: int
    total_count: int
    blob_bytes: int              # sum of LENGTH(thermal_jpeg) across all rows
    oldest_pending_at: Optional[str]


class BufferStore:
    """
    Persistent SQLite buffer for offline API payloads.

    Parameters
    ----------
    db_path
        Filesystem path to the SQLite file (created if absent).
    max_rows
        Maximum number of *pending* rows.  When exceeded, the oldest
        pending rows are deleted before the new entry is written.
    max_size_mb
        Soft limit on the total size of stored BLOBs (thermal JPEGs).
        Oldest BLOB-bearing rows are evicted when this is exceeded.
    prune_done_after_hours
        Rows in 'done' or 'failed' status older than this are deleted
        on each `prune()` call.
    """

    def __init__(
        self,
        db_path: str,
        max_rows: int = 10_000,
        max_size_mb: float = 512.0,
        prune_done_after_hours: int = 24,
    ) -> None:
        self._db_path = db_path
        self._max_rows = max_rows
        self._max_bytes = int(max_size_mb * 1024 * 1024)
        self._prune_hours = prune_done_after_hours
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def open(self) -> None:
        """Create the DB file and apply the schema (idempotent)."""
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            self._db_path,
            check_same_thread=False,
            isolation_level=None,   # Autocommit; we issue explicit BEGIN/COMMIT
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA_SQL)
        logger.info(
            "BufferStore opened",
            extra={"db": self._db_path, "max_rows": self._max_rows, "max_mb": self._max_bytes // (1024 * 1024)},
        )

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
        logger.info("BufferStore closed")

    # ── Write operations ──────────────────────────────────────────────────────

    def enqueue(self, entry: BufferedEntry) -> int:
        """
        Persist *entry* as a new 'pending' row.

        Buffer limits are enforced before the insert — oldest pending
        entries are evicted silently (a warning is logged) to make room.

        Returns the auto-assigned row id.
        """
        self._assert_open()
        now = datetime.now(timezone.utc).isoformat()

        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._enforce_limits()
                cur = self._conn.execute(
                    """
                    INSERT INTO pending_uploads
                        (upload_type, pile_id, site_id, captured_at,
                         payload_json, thermal_jpeg, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry.upload_type,
                        entry.pile_id,
                        entry.site_id,
                        entry.captured_at,
                        entry.payload_json,
                        entry.thermal_jpeg,
                        now,
                    ),
                )
                row_id = cur.lastrowid
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

        logger.debug(
            "Upload buffered",
            extra={"id": row_id, "type": entry.upload_type, "pile_id": entry.pile_id},
        )
        return row_id  # type: ignore[return-value]

    def mark_synced(self, row_id: int) -> None:
        """Mark a row as successfully synced."""
        self._assert_open()
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._conn.execute(
                "UPDATE pending_uploads SET status='done', synced_at=? WHERE id=?",
                (now, row_id),
            )

    def mark_failed(self, row_id: int, error: str, max_attempts: int = 5) -> None:
        """
        Record a failed sync attempt.

        If `attempts` reaches `max_attempts` the row is permanently marked
        'failed' and will not be retried.  Otherwise it returns to 'pending'.
        """
        self._assert_open()
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            row = self._conn.execute(
                "SELECT attempts FROM pending_uploads WHERE id=?", (row_id,)
            ).fetchone()
            if row is None:
                return
            new_attempts = row["attempts"] + 1
            new_status = "failed" if new_attempts >= max_attempts else "pending"
            self._conn.execute(
                """
                UPDATE pending_uploads
                SET status=?, attempts=?, last_attempt_at=?, last_error=?
                WHERE id=?
                """,
                (new_status, new_attempts, now, error[:500], row_id),
            )

    def reset_syncing(self) -> int:
        """
        Reset rows stuck in 'syncing' back to 'pending'.

        Call once at startup to recover from an unclean shutdown that
        occurred mid-sync.
        """
        self._assert_open()
        with self._lock:
            cur = self._conn.execute(
                "UPDATE pending_uploads SET status='pending' WHERE status='syncing'"
            )
            count = cur.rowcount
        if count:
            logger.warning(
                "Recovered %d rows stuck in 'syncing' (unclean shutdown)",
                count,
            )
        return count

    # ── Read operations ───────────────────────────────────────────────────────

    def dequeue_pending(self, limit: int = 50) -> List[BufferedEntry]:
        """
        Return up to *limit* pending entries in FIFO order and atomically
        mark them 'syncing'.

        The rows remain in the DB (marked 'syncing') until the caller
        calls `mark_synced()` or `mark_failed()`.  This guarantees that
        buffered data is never silently dropped.
        """
        self._assert_open()
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                rows = self._conn.execute(
                    """
                    SELECT id, upload_type, pile_id, site_id, captured_at,
                           payload_json, thermal_jpeg, attempts, last_error
                    FROM   pending_uploads
                    WHERE  status = 'pending'
                    ORDER  BY created_at ASC
                    LIMIT  ?
                    """,
                    (limit,),
                ).fetchall()

                if rows:
                    ids = [r["id"] for r in rows]
                    placeholders = ",".join("?" * len(ids))
                    self._conn.execute(
                        f"UPDATE pending_uploads SET status='syncing' WHERE id IN ({placeholders})",
                        ids,
                    )

                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

        return [
            BufferedEntry(
                row_id=r["id"],
                upload_type=r["upload_type"],
                pile_id=r["pile_id"],
                site_id=r["site_id"],
                captured_at=r["captured_at"],
                payload_json=r["payload_json"],
                thermal_jpeg=bytes(r["thermal_jpeg"]) if r["thermal_jpeg"] else None,
                attempts=r["attempts"],
                last_error=r["last_error"],
            )
            for r in rows
        ]

    # ── Maintenance ───────────────────────────────────────────────────────────

    def prune(self) -> int:
        """
        Delete 'done' and 'failed' rows older than `prune_done_after_hours`.

        Returns the number of rows deleted.  Also runs `PRAGMA
        incremental_vacuum` to reclaim freed pages.
        """
        self._assert_open()
        cutoff = (
            datetime.now(timezone.utc) - timedelta(hours=self._prune_hours)
        ).isoformat()

        with self._lock:
            cur = self._conn.execute(
                """
                DELETE FROM pending_uploads
                WHERE  status IN ('done', 'failed')
                AND    created_at < ?
                """,
                (cutoff,),
            )
            deleted = cur.rowcount
            # Incrementally reclaim freed pages (non-blocking, max 200 pages)
            self._conn.execute("PRAGMA incremental_vacuum(200)")

        if deleted:
            logger.info("Pruned %d old buffer entries", deleted, extra={"cutoff": cutoff})
        return deleted

    def stats(self) -> BufferStats:
        """Return current buffer counts and size."""
        self._assert_open()
        with self._lock:
            status_rows = self._conn.execute(
                "SELECT status, COUNT(*) AS n FROM pending_uploads GROUP BY status"
            ).fetchall()
            blob_row = self._conn.execute(
                "SELECT COALESCE(SUM(LENGTH(thermal_jpeg)), 0) FROM pending_uploads"
            ).fetchone()
            oldest_row = self._conn.execute(
                "SELECT MIN(created_at) FROM pending_uploads WHERE status='pending'"
            ).fetchone()

        counts = {r["status"]: r["n"] for r in status_rows}
        return BufferStats(
            pending_count=counts.get("pending", 0),
            syncing_count=counts.get("syncing", 0),
            done_count=counts.get("done", 0),
            failed_count=counts.get("failed", 0),
            total_count=sum(counts.values()),
            blob_bytes=int(blob_row[0]) if blob_row else 0,
            oldest_pending_at=oldest_row[0] if oldest_row else None,
        )

    # ── Private helpers ───────────────────────────────────────────────────────

    def _enforce_limits(self) -> None:
        """
        Evict pending entries to stay within configured limits.

        Must be called inside a `BEGIN IMMEDIATE` transaction and while
        holding `self._lock`.
        """
        # ── Row limit ─────────────────────────────────────────────────────────
        pending = self._conn.execute(  # type: ignore[union-attr]
            "SELECT COUNT(*) FROM pending_uploads WHERE status='pending'"
        ).fetchone()[0]

        if pending >= self._max_rows:
            evict = pending - self._max_rows + 1
            self._conn.execute(  # type: ignore[union-attr]
                """
                DELETE FROM pending_uploads
                WHERE  id IN (
                    SELECT id FROM pending_uploads
                    WHERE  status = 'pending'
                    ORDER  BY created_at ASC
                    LIMIT  ?
                )
                """,
                (evict,),
            )
            logger.warning(
                "Buffer row limit reached — evicted oldest entries",
                extra={"evicted": evict, "max_rows": self._max_rows},
            )

        # ── BLOB size limit ───────────────────────────────────────────────────
        if self._max_bytes <= 0:
            return

        blob_total = self._conn.execute(  # type: ignore[union-attr]
            "SELECT COALESCE(SUM(LENGTH(thermal_jpeg)), 0) FROM pending_uploads WHERE status='pending'"
        ).fetchone()[0]

        while blob_total > self._max_bytes:
            deleted = self._conn.execute(  # type: ignore[union-attr]
                """
                DELETE FROM pending_uploads
                WHERE id IN (
                    SELECT id FROM pending_uploads
                    WHERE  status = 'pending' AND thermal_jpeg IS NOT NULL
                    ORDER  BY created_at ASC
                    LIMIT  5
                )
                """,
            ).rowcount
            if deleted == 0:
                break
            blob_total = self._conn.execute(  # type: ignore[union-attr]
                "SELECT COALESCE(SUM(LENGTH(thermal_jpeg)), 0) FROM pending_uploads WHERE status='pending'"
            ).fetchone()[0]
            logger.warning(
                "Buffer BLOB limit exceeded — evicted oldest thermal entries",
                extra={"blob_bytes": blob_total, "limit_bytes": self._max_bytes},
            )

    def _assert_open(self) -> None:
        if self._conn is None:
            raise RuntimeError("BufferStore is not open — call open() first")
