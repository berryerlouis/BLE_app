"""SQLite-backed persistence for satellite device state and message history.

Keeps the same data the web dashboard already shows in memory, but on disk,
so the page can retrieve previously received satellite data after a restart.
All blocking sqlite3 calls run in a worker thread to avoid stalling the event loop.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data.db"
MAX_LOG_ENTRIES_PER_DEVICE = 2000
DEFAULT_IMPACT_THRESHOLD = 8.0  # g, magnitude of the acceleration vector


class Database:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH):
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    summary TEXT NOT NULL,
                    label_name TEXT,
                    label_number INTEGER,
                    impact_threshold REAL,
                    impact_alert INTEGER
                );
                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    timestamp REAL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_logs_device ON logs(device_id, id);
                """
            )
            # Migrate databases created before these values had dedicated columns.
            existing_columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(devices)")}
            if "label_name" not in existing_columns:
                self._conn.execute("ALTER TABLE devices ADD COLUMN label_name TEXT")
            if "label_number" not in existing_columns:
                self._conn.execute("ALTER TABLE devices ADD COLUMN label_number INTEGER")
            if "impact_threshold" not in existing_columns:
                self._conn.execute("ALTER TABLE devices ADD COLUMN impact_threshold REAL")
            if "impact_alert" not in existing_columns:
                self._conn.execute("ALTER TABLE devices ADD COLUMN impact_alert INTEGER")
            self._conn.commit()
            self._backfill_label_columns()
            self._backfill_impact_columns()

    def _backfill_impact_columns(self) -> None:
        """Copy impact_threshold/impact_alert out of the legacy JSON summary blob into their own columns."""
        rows = self._conn.execute(
            "SELECT device_id, summary FROM devices WHERE impact_threshold IS NULL"
        ).fetchall()
        for row in rows:
            summary = json.loads(row["summary"])
            self._conn.execute(
                "UPDATE devices SET impact_threshold = ?, impact_alert = ? WHERE device_id = ?",
                (
                    summary.get("impact_threshold", DEFAULT_IMPACT_THRESHOLD),
                    int(bool(summary.get("impact_alert"))),
                    row["device_id"],
                ),
            )
        self._conn.commit()

    def _backfill_label_columns(self) -> None:
        """Copy label_name/label_number out of the legacy JSON summary blob into their own columns."""
        rows = self._conn.execute(
            "SELECT device_id, summary FROM devices WHERE label_name IS NULL AND label_number IS NULL"
        ).fetchall()
        for row in rows:
            summary = json.loads(row["summary"])
            name = summary.get("label_name")
            number = summary.get("label_number")
            if name is not None or number is not None:
                self._conn.execute(
                    "UPDATE devices SET label_name = ?, label_number = ? WHERE device_id = ?",
                    (name, number, row["device_id"]),
                )
        self._conn.commit()

    async def load_all(self) -> tuple[dict, dict]:
        return await asyncio.get_running_loop().run_in_executor(None, self._load_all_sync)

    def _load_all_sync(self) -> tuple[dict, dict]:
        with self._lock:
            devices = {}
            for row in self._conn.execute(
                "SELECT device_id, summary, label_name, label_number, impact_threshold, impact_alert FROM devices"
            ):
                summary = json.loads(row["summary"])
                if row["label_name"] is not None:
                    summary["label_name"] = row["label_name"]
                if row["label_number"] is not None:
                    summary["label_number"] = row["label_number"]
                if row["impact_threshold"] is not None:
                    summary["impact_threshold"] = row["impact_threshold"]
                if row["impact_alert"] is not None:
                    summary["impact_alert"] = bool(row["impact_alert"])
                devices[row["device_id"]] = summary
            logs: dict[str, list[dict]] = {}
            for row in self._conn.execute("SELECT device_id, payload FROM logs ORDER BY id"):
                logs.setdefault(row["device_id"], []).append(json.loads(row["payload"]))
            return devices, logs

    async def save_device(self, device_id: str, summary: dict) -> None:
        await asyncio.get_running_loop().run_in_executor(None, self._save_device_sync, device_id, summary)

    def _save_device_sync(self, device_id: str, summary: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO devices (device_id, summary, label_name, label_number, impact_threshold, impact_alert) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(device_id) DO UPDATE SET "
                "summary = excluded.summary, label_name = excluded.label_name, "
                "label_number = excluded.label_number, impact_threshold = excluded.impact_threshold, "
                "impact_alert = excluded.impact_alert",
                (
                    device_id,
                    json.dumps(summary),
                    summary.get("label_name"),
                    summary.get("label_number"),
                    summary.get("impact_threshold", DEFAULT_IMPACT_THRESHOLD),
                    int(bool(summary.get("impact_alert"))),
                ),
            )
            self._conn.commit()

    async def append_log(self, device_id: str, item: dict) -> None:
        await asyncio.get_running_loop().run_in_executor(None, self._append_log_sync, device_id, item)

    def _append_log_sync(self, device_id: str, item: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO logs (device_id, timestamp, payload) VALUES (?, ?, ?)",
                (device_id, item.get("timestamp"), json.dumps(item)),
            )
            self._conn.execute(
                """
                DELETE FROM logs WHERE device_id = ? AND id NOT IN (
                    SELECT id FROM logs WHERE device_id = ? ORDER BY id DESC LIMIT ?
                )
                """,
                (device_id, device_id, MAX_LOG_ENTRIES_PER_DEVICE),
            )
            self._conn.commit()

    async def close(self) -> None:
        await asyncio.get_running_loop().run_in_executor(None, self._conn.close)
