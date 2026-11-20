"""SQLite persistence layer.

A single long-lived aiosqlite connection is shared by the whole process. aiosqlite
runs every statement on one dedicated thread, so all writes from this process are
serialised without ever blocking the event loop, and we avoid the cost (and the
lock contention) of opening a new connection per call.

Idempotency is enforced by the database itself: ``idempotency_key`` carries a
UNIQUE constraint and new events are written with ``INSERT ... ON CONFLICT DO
NOTHING``. Whichever request commits first wins; every concurrent duplicate gets
``rowcount == 0`` and is acknowledged without being processed again. Because the
guarantee lives in the database rather than in Python memory, it also holds
across multiple worker processes sharing the same file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import aiosqlite

DB_PATH = os.getenv("WEBHOOK_DB_PATH", "webhooks.db")

STATUS_PENDING = "pending"
STATUS_DELIVERED = "delivered"
STATUS_FAILED = "failed"


@dataclass(frozen=True)
class PendingEvent:
    event_id: str
    cleaned_text: str
    fingerprint: str | None


class Database:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.getenv("WEBHOOK_DB_PATH", DB_PATH)
        self._conn: aiosqlite.Connection | None = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database is not connected")
        return self._conn

    async def connect(self) -> None:
        self._conn = await aiosqlite.connect(self.path)
        # WAL lets readers proceed while a write is in progress and makes commits
        # cheap (no full journal rewrite). busy_timeout makes a second process wait
        # for the write lock instead of failing immediately with "database is locked".
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.execute("PRAGMA busy_timeout=5000")
        await self._init_schema()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def _init_schema(self) -> None:
        await self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT,
                event_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                cleaned_text TEXT NOT NULL,
                fingerprint TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # Upgrade a database created by the original schema in place.
        cursor = await self.conn.execute("PRAGMA table_info(events)")
        columns = {row[1] for row in await cursor.fetchall()}
        for name, ddl in (
            ("idempotency_key", "TEXT"),
            ("attempts", "INTEGER NOT NULL DEFAULT 0"),
            ("last_error", "TEXT"),
            ("updated_at", "TIMESTAMP"),
        ):
            if name not in columns:
                await self.conn.execute(f"ALTER TABLE events ADD COLUMN {name} {ddl}")

        await self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_events_idempotency_key "
            "ON events (idempotency_key)"
        )
        await self.conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_events_status ON events (status)"
        )
        await self.conn.commit()

    async def insert_if_new(
        self,
        idempotency_key: str,
        event_id: str,
        tenant_id: str,
        cleaned_text: str,
    ) -> bool:
        """Atomically claim an idempotency key. Returns True only for the first caller."""
        cursor = await self.conn.execute(
            """
            INSERT INTO events (idempotency_key, event_id, tenant_id, cleaned_text, status)
            VALUES (?, ?, ?, ?, 'pending')
            ON CONFLICT (idempotency_key) DO NOTHING
            """,
            (idempotency_key, event_id, tenant_id, cleaned_text),
        )
        await self.conn.commit()
        return cursor.rowcount == 1

    async def set_fingerprint(self, idempotency_key: str, fingerprint: str) -> None:
        await self.conn.execute(
            "UPDATE events SET fingerprint = ?, updated_at = CURRENT_TIMESTAMP "
            "WHERE idempotency_key = ?",
            (fingerprint, idempotency_key),
        )
        await self.conn.commit()

    async def record_attempt(self, idempotency_key: str, error: str | None) -> None:
        await self.conn.execute(
            "UPDATE events SET attempts = attempts + 1, last_error = ?, "
            "updated_at = CURRENT_TIMESTAMP WHERE idempotency_key = ?",
            (error, idempotency_key),
        )
        await self.conn.commit()

    async def set_status(self, idempotency_key: str, status: str) -> None:
        await self.conn.execute(
            "UPDATE events SET status = ?, updated_at = CURRENT_TIMESTAMP "
            "WHERE idempotency_key = ?",
            (status, idempotency_key),
        )
        await self.conn.commit()

    async def get_pending(self, idempotency_key: str) -> PendingEvent | None:
        cursor = await self.conn.execute(
            "SELECT event_id, cleaned_text, fingerprint FROM events "
            "WHERE idempotency_key = ? AND status = 'pending'",
            (idempotency_key,),
        )
        row = await cursor.fetchone()
        return PendingEvent(*row) if row else None

    async def pending_keys(self) -> list[str]:
        """Keys accepted but not yet delivered, e.g. left over from a crash."""
        cursor = await self.conn.execute(
            "SELECT idempotency_key FROM events "
            "WHERE status = 'pending' AND idempotency_key IS NOT NULL ORDER BY id"
        )
        return [row[0] for row in await cursor.fetchall()]
