from __future__ import annotations

import asyncio
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ScanHit:
    id: Optional[int]
    timestamp: float
    frequency: float
    channel: Optional[int]
    alpha_tag: Optional[str]
    modulation: str
    rssi: int
    duration: Optional[float]
    mode: str
    bank: Optional[int]
    session_id: str
    ended_at: Optional[float]


@dataclass
class BusiestChannel:
    rank: int
    frequency: float
    alpha_tag: Optional[str]
    hit_count: int
    avg_duration: float
    channel: Optional[int]
    last_seen: float


@dataclass
class HeatmapCell:
    hour: int
    day: int
    count: int


@dataclass
class SessionStats:
    total_hits: int
    avg_rssi: float
    active_time_seconds: float
    unique_channels: int


class AnalyticsDatabase:
    def __init__(self, db_path: str):
        self.db_path = Path(db_path)
        self._conn: Optional[sqlite3.Connection] = None
        self._write_queue: asyncio.Queue = asyncio.Queue()
        self._writer_task: Optional[asyncio.Task] = None
        self._open_hits: dict[float, int] = {}  # frequency -> hit_id mapping
        self._open_hits_lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize database connection and create schema."""
        self._conn = sqlite3.connect(
            self.db_path, check_same_thread=False, isolation_level=None, timeout=10.0
        )
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        await self._create_schema()
        self._writer_task = asyncio.create_task(self._batch_writer())

    async def close(self) -> None:
        """Close database connection and stop writer task."""
        if self._writer_task:
            self._writer_task.cancel()
            try:
                await self._writer_task
            except asyncio.CancelledError:
                pass
        if self._conn:
            self._conn.close()
            self._conn = None

    async def _create_schema(self) -> None:
        """Create database tables and indexes."""
        await asyncio.to_thread(self._create_schema_sync)

    def _create_schema_sync(self) -> None:
        """Synchronous schema creation."""
        if not self._conn:
            return

        # Main scan hits table
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS scan_hits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                frequency REAL NOT NULL,
                channel INTEGER,
                alpha_tag TEXT,
                modulation TEXT NOT NULL,
                rssi INTEGER NOT NULL,
                duration REAL,
                mode TEXT NOT NULL,
                bank INTEGER,
                session_id TEXT NOT NULL,
                ended_at REAL
            )
        """)

        # Performance indexes
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_hits_timestamp
            ON scan_hits(timestamp DESC)
        """)

        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_hits_channel
            ON scan_hits(channel) WHERE channel IS NOT NULL
        """)

        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_hits_frequency
            ON scan_hits(frequency)
        """)

        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_hits_composite
            ON scan_hits(timestamp, channel, frequency)
        """)

        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_hits_session
            ON scan_hits(session_id)
        """)

        # Hourly aggregation table (materialized view)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS hourly_stats (
                hour_bucket INTEGER NOT NULL,
                frequency REAL NOT NULL,
                hit_count INTEGER NOT NULL,
                total_duration REAL NOT NULL,
                avg_rssi REAL NOT NULL,
                PRIMARY KEY (hour_bucket, frequency)
            )
        """)

        self._conn.commit()

    async def record_hit_start(
        self,
        timestamp: float,
        frequency: float,
        channel: Optional[int],
        alpha_tag: Optional[str],
        modulation: str,
        rssi: int,
        mode: str,
        session_id: str,
        bank: Optional[int] = None,
    ) -> None:
        """Record the start of a scan hit (squelch open)."""
        hit = ScanHit(
            id=None,
            timestamp=timestamp,
            frequency=frequency,
            channel=channel,
            alpha_tag=alpha_tag,
            modulation=modulation,
            rssi=rssi,
            duration=None,
            mode=mode,
            bank=bank,
            session_id=session_id,
            ended_at=None,
        )
        await self._write_queue.put(("insert_hit", hit))

    async def record_hit_end(self, frequency: float, timestamp: float) -> None:
        """Record the end of a scan hit (squelch close) and calculate duration."""
        await self._write_queue.put(("end_hit", (frequency, timestamp)))

    async def _batch_writer(self) -> None:
        """Background task that batches database writes."""
        batch = []
        batch_size = 10
        flush_interval = 5.0  # seconds
        last_flush = time.monotonic()

        while True:
            try:
                # Wait for item with timeout
                timeout = flush_interval - (time.monotonic() - last_flush)
                timeout = max(0.1, timeout)

                try:
                    item = await asyncio.wait_for(
                        self._write_queue.get(), timeout=timeout
                    )
                    batch.append(item)
                except asyncio.TimeoutError:
                    pass

                # Flush if batch is full or interval elapsed
                should_flush = (
                    len(batch) >= batch_size
                    or time.monotonic() - last_flush >= flush_interval
                )

                if should_flush and batch:
                    await self._flush_batch(batch)
                    batch = []
                    last_flush = time.monotonic()

            except asyncio.CancelledError:
                # Flush remaining items before exit
                if batch:
                    await self._flush_batch(batch)
                raise

    async def _flush_batch(self, batch: list) -> None:
        """Write a batch of operations to the database."""
        await asyncio.to_thread(self._flush_batch_sync, batch)

    def _flush_batch_sync(self, batch: list) -> None:
        """Synchronous batch write."""
        if not self._conn:
            return

        for operation, data in batch:
            if operation == "insert_hit":
                hit: ScanHit = data
                cursor = self._conn.execute(
                    """
                    INSERT INTO scan_hits (
                        timestamp, frequency, channel, alpha_tag, modulation,
                        rssi, duration, mode, bank, session_id, ended_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        hit.timestamp,
                        hit.frequency,
                        hit.channel,
                        hit.alpha_tag,
                        hit.modulation,
                        hit.rssi,
                        hit.duration,
                        hit.mode,
                        hit.bank,
                        hit.session_id,
                        hit.ended_at,
                    ),
                )
                # Track open hit by frequency
                rowid = int(cursor.lastrowid) if cursor.lastrowid else 0
                # Use direct dict access since this is synchronous
                self._open_hits[hit.frequency] = rowid

            elif operation == "end_hit":
                frequency, end_timestamp = data
                hit_id = self._open_hits.pop(frequency, None)
                if hit_id:
                    # Update the hit with end time and duration
                    self._conn.execute(
                        """
                        UPDATE scan_hits
                        SET ended_at = ?,
                            duration = ? - timestamp
                        WHERE id = ?
                        """,
                        (end_timestamp, end_timestamp, hit_id),
                    )

        self._conn.commit()

    async def get_busiest_channels(
        self, limit: int = 10, hours: float = 24.0, min_duration: float = 3.0
    ) -> list[BusiestChannel]:
        """Get the busiest channels by hit count within the time window."""
        return await asyncio.to_thread(
            self._get_busiest_channels_sync, limit, hours, min_duration
        )

    def _get_busiest_channels_sync(
        self, limit: int, hours: float, min_duration: float
    ) -> list[BusiestChannel]:
        """Synchronous busiest channels query."""
        if not self._conn:
            return []

        cutoff = time.time() - (hours * 3600)
        cursor = self._conn.execute(
            """
            SELECT
                frequency,
                alpha_tag,
                channel,
                COUNT(*) as hit_count,
                AVG(duration) as avg_duration,
                MAX(timestamp) as last_seen
            FROM scan_hits
            WHERE timestamp >= ?
              AND duration IS NOT NULL
              AND duration >= ?
            GROUP BY frequency
            ORDER BY hit_count DESC
            LIMIT ?
            """,
            (cutoff, min_duration, limit),
        )

        results = []
        for rank, row in enumerate(cursor.fetchall(), start=1):
            results.append(
                BusiestChannel(
                    rank=rank,
                    frequency=row[0],
                    alpha_tag=row[1],
                    channel=row[2],
                    hit_count=row[3],
                    avg_duration=row[4] or 0.0,
                    last_seen=row[5],
                )
            )

        return results

    async def get_hourly_heatmap(
        self, days: int = 7, min_duration: float = 3.0
    ) -> list[HeatmapCell]:
        """Get hourly hit counts for heatmap visualization."""
        return await asyncio.to_thread(
            self._get_hourly_heatmap_sync, days, min_duration
        )

    def _get_hourly_heatmap_sync(
        self, days: int, min_duration: float
    ) -> list[HeatmapCell]:
        """Synchronous heatmap query."""
        if not self._conn:
            return []

        cutoff = time.time() - (days * 86400)
        cursor = self._conn.execute(
            """
            SELECT
                CAST(strftime('%H', datetime(timestamp, 'unixepoch', 'localtime')) AS INTEGER) as hour,
                CAST(strftime('%w', datetime(timestamp, 'unixepoch', 'localtime')) AS INTEGER) as day,
                COUNT(*) as count
            FROM scan_hits
            WHERE timestamp >= ?
              AND duration IS NOT NULL
              AND duration >= ?
            GROUP BY hour, day
            ORDER BY day, hour
            """,
            (cutoff, min_duration),
        )

        return [
            HeatmapCell(hour=row[0], day=row[1], count=row[2])
            for row in cursor.fetchall()
        ]

    async def get_session_stats(
        self, session_id: str, min_duration: float = 3.0
    ) -> SessionStats:
        """Get statistics for the current session."""
        return await asyncio.to_thread(
            self._get_session_stats_sync, session_id, min_duration
        )

    def _get_session_stats_sync(
        self, session_id: str, min_duration: float
    ) -> SessionStats:
        """Synchronous session stats query."""
        if not self._conn:
            return SessionStats(
                total_hits=0, avg_rssi=0.0, active_time_seconds=0.0, unique_channels=0
            )

        cursor = self._conn.execute(
            """
            SELECT
                COUNT(*) as total_hits,
                AVG(rssi) as avg_rssi,
                SUM(COALESCE(duration, 0)) as active_time,
                COUNT(DISTINCT channel) as unique_channels
            FROM scan_hits
            WHERE session_id = ?
              AND duration IS NOT NULL
              AND duration >= ?
            """,
            (session_id, min_duration),
        )

        row = cursor.fetchone()
        if not row:
            return SessionStats(
                total_hits=0, avg_rssi=0.0, active_time_seconds=0.0, unique_channels=0
            )

        return SessionStats(
            total_hits=row[0] or 0,
            avg_rssi=row[1] or 0.0,
            active_time_seconds=row[2] or 0.0,
            unique_channels=row[3] or 0,
        )

    async def cleanup_old_data(self, retention_days: int = 30) -> int:
        """Remove data older than retention period. Returns number of deleted records."""
        return await asyncio.to_thread(self._cleanup_old_data_sync, retention_days)

    def _cleanup_old_data_sync(self, retention_days: int) -> int:
        """Synchronous cleanup operation."""
        if not self._conn:
            return 0

        cutoff = time.time() - (retention_days * 86400)
        cursor = self._conn.execute(
            "DELETE FROM scan_hits WHERE timestamp < ?", (cutoff,)
        )
        self._conn.commit()
        return cursor.rowcount
