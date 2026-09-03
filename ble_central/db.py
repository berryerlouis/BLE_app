"""SQLite-backed persistence for satellite device state, message history, and match sessions.

Organizes telemetry and event logs by sessions (1 session = 1 match/training per player),
allowing coaches and analysts to review past matches as well as monitor live sessions.
All blocking sqlite3 calls run in a worker thread to avoid stalling the event loop.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data.db"
MAX_LOG_ENTRIES_PER_DEVICE = 2000
DEFAULT_IMPACT_THRESHOLD = 8.0  # g, magnitude of the acceleration vector


class Database:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH):
        self._conn = sqlite3.connect(str(db_path), timeout=30.0, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=30000")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    start_time REAL NOT NULL,
                    end_time REAL,
                    is_active INTEGER DEFAULT 1,
                    created_at REAL NOT NULL,
                    notes TEXT
                );

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
                    session_id INTEGER,
                    device_id TEXT NOT NULL,
                    msg_type TEXT,
                    mag REAL,
                    temp REAL,
                    battery_pct INTEGER,
                    battery_v REAL,
                    timestamp REAL,
                    payload TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                """
            )
            # Migrate columns if not present
            device_cols = {row["name"] for row in self._conn.execute("PRAGMA table_info(devices)")}
            if "label_name" not in device_cols:
                self._conn.execute("ALTER TABLE devices ADD COLUMN label_name TEXT")
            if "label_number" not in device_cols:
                self._conn.execute("ALTER TABLE devices ADD COLUMN label_number INTEGER")
            if "impact_threshold" not in device_cols:
                self._conn.execute("ALTER TABLE devices ADD COLUMN impact_threshold REAL")
            if "impact_alert" not in device_cols:
                self._conn.execute("ALTER TABLE devices ADD COLUMN impact_alert INTEGER")

            log_cols = {row["name"] for row in self._conn.execute("PRAGMA table_info(logs)")}
            if "session_id" not in log_cols:
                self._conn.execute("ALTER TABLE logs ADD COLUMN session_id INTEGER")
            if "msg_type" not in log_cols:
                self._conn.execute("ALTER TABLE logs ADD COLUMN msg_type TEXT")
            if "mag" not in log_cols:
                self._conn.execute("ALTER TABLE logs ADD COLUMN mag REAL")
            if "temp" not in log_cols:
                self._conn.execute("ALTER TABLE logs ADD COLUMN temp REAL")
            if "battery_pct" not in log_cols:
                self._conn.execute("ALTER TABLE logs ADD COLUMN battery_pct INTEGER")
            if "battery_v" not in log_cols:
                self._conn.execute("ALTER TABLE logs ADD COLUMN battery_v REAL")

            # Create indices after columns are guaranteed to exist
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_session_device ON logs(session_id, device_id, id)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_session_type ON logs(session_id, msg_type)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_device ON logs(device_id, id)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active)")

            self._conn.commit()
            self._backfill_label_columns()
            self._backfill_impact_columns()
            self._backfill_log_columns()

    def _get_active_session_sync(self) -> dict | None:
        """Return the current active session, if one exists."""
        row = self._conn.execute("SELECT * FROM sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            return None
        result = dict(row)
        result["is_active"] = bool(result["is_active"])
        return result

    def _backfill_log_columns(self) -> None:
        """One-time migration: populate session_id, msg_type and mag from payload for older databases."""
        null_count_row = self._conn.execute("SELECT COUNT(*) as c FROM logs WHERE msg_type IS NULL OR session_id IS NULL").fetchone()
        if null_count_row and null_count_row["c"] > 0:
            active_row = self._conn.execute("SELECT id FROM sessions ORDER BY id ASC LIMIT 1").fetchone()
            default_id = active_row["id"] if active_row else 1
            rows = self._conn.execute("SELECT id, payload, session_id FROM logs WHERE msg_type IS NULL OR session_id IS NULL").fetchall()
            for r in rows:
                try:
                    p = json.loads(r["payload"])
                    t = p.get("type")
                    mag = None
                    if t == "imu":
                        mag = math.sqrt(p.get("aX", 0)**2 + p.get("aY", 0)**2 + p.get("aZ", 0)**2)
                    elif t == "impact":
                        mag = p.get("impact_value")
                    temp = p.get("temp")
                    pct = p.get("percentage")
                    v = p.get("voltage")
                    s_id = r["session_id"] or default_id

                    self._conn.execute(
                        "UPDATE logs SET session_id = ?, msg_type = ?, mag = ?, temp = ?, battery_pct = ?, battery_v = ? WHERE id = ?",
                        (s_id, t, mag, temp, pct, v, r["id"]),
                    )
                except Exception:
                    pass
            self._conn.commit()

    def _backfill_impact_columns(self) -> None:
        """Copy impact_threshold/impact_alert out of the legacy JSON summary blob into their own columns."""
        rows = self._conn.execute(
            "SELECT device_id, summary FROM devices WHERE impact_threshold IS NULL"
        ).fetchall()
        for row in rows:
            try:
                summary = json.loads(row["summary"])
            except Exception:
                continue
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
            try:
                summary = json.loads(row["summary"])
            except Exception:
                continue
            name = summary.get("label_name")
            number = summary.get("label_number")
            if name is not None or number is not None:
                self._conn.execute(
                    "UPDATE devices SET label_name = ?, label_number = ? WHERE device_id = ?",
                    (name, number, row["device_id"]),
                )
        self._conn.commit()

    # =========================================================================
    # Session Management Methods
    # =========================================================================

    async def get_active_session(self) -> dict | None:
        return await asyncio.get_running_loop().run_in_executor(None, self._get_active_session_sync)

    async def end_active_sessions(self) -> None:
        await asyncio.get_running_loop().run_in_executor(None, self._end_active_sessions_sync)

    def _end_active_sessions_sync(self) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET is_active = 0, end_time = COALESCE(end_time, ?) WHERE is_active = 1",
                (time.time(),),
            )
            self._conn.commit()

    async def list_sessions(self) -> list[dict]:
        return await asyncio.get_running_loop().run_in_executor(None, self._list_sessions_sync)

    def _list_sessions_sync(self) -> list[dict]:
        with self._lock:
            query = """
                SELECT 
                    s.id,
                    s.name,
                    s.start_time,
                    s.end_time,
                    s.is_active,
                    s.created_at,
                    s.notes,
                    COUNT(l.id) AS log_count,
                    COUNT(DISTINCT l.device_id) AS device_count,
                    COUNT(CASE WHEN l.msg_type = 'impact' THEN 1 END) AS impact_count
                FROM sessions s
                LEFT JOIN logs l ON s.id = l.session_id
                GROUP BY s.id
                ORDER BY s.id DESC
            """
            rows = self._conn.execute(query).fetchall()
            results = []
            for row in rows:
                session_dict = dict(row)
                session_dict["is_active"] = bool(row["is_active"])
                session_dict["impact_count"] = row["impact_count"] or 0
                results.append(session_dict)
            return results

    async def get_session(self, session_id: int) -> dict | None:
        return await asyncio.get_running_loop().run_in_executor(None, self._get_session_sync, session_id)

    def _get_session_sync(self, session_id: int) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None
            res = dict(row)
            res["is_active"] = bool(res["is_active"])
            return res

    async def create_session(self, name: str, notes: str = "", set_active: bool = True) -> dict:
        return await asyncio.get_running_loop().run_in_executor(
            None, self._create_session_sync, name, notes, set_active
        )

    def _create_session_sync(self, name: str, notes: str = "", set_active: bool = True) -> dict:
        with self._lock:
            now = time.time()
            if set_active:
                self._conn.execute(
                    "UPDATE sessions SET is_active = 0, end_time = COALESCE(end_time, ?) WHERE is_active = 1",
                    (now,),
                )
            cur = self._conn.execute(
                "INSERT INTO sessions (name, start_time, is_active, created_at, notes) VALUES (?, ?, ?, ?, ?)",
                (name, now, 1 if set_active else 0, now, notes),
            )
            session_id = cur.lastrowid
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            res = dict(row)
            res["is_active"] = bool(res["is_active"])
            return res

    async def end_session(self, session_id: int) -> dict | None:
        return await asyncio.get_running_loop().run_in_executor(None, self._end_session_sync, session_id)

    def _end_session_sync(self, session_id: int) -> dict | None:
        with self._lock:
            now = time.time()
            self._conn.execute(
                "UPDATE sessions SET is_active = 0, end_time = ? WHERE id = ?",
                (now, session_id),
            )
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None
            res = dict(row)
            res["is_active"] = bool(res["is_active"])
            return res

    async def activate_session(self, session_id: int) -> dict | None:
        return await asyncio.get_running_loop().run_in_executor(None, self._activate_session_sync, session_id)

    def _activate_session_sync(self, session_id: int) -> dict | None:
        with self._lock:
            self._conn.execute("UPDATE sessions SET is_active = 0")
            self._conn.execute("UPDATE sessions SET is_active = 1, end_time = NULL WHERE id = ?", (session_id,))
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None
            res = dict(row)
            res["is_active"] = bool(res["is_active"])
            return res

    async def update_session(self, session_id: int, name: str | None = None, notes: str | None = None) -> dict | None:
        return await asyncio.get_running_loop().run_in_executor(
            None, self._update_session_sync, session_id, name, notes
        )

    def _update_session_sync(self, session_id: int, name: str | None = None, notes: str | None = None) -> dict | None:
        with self._lock:
            if name is not None and notes is not None:
                self._conn.execute("UPDATE sessions SET name = ?, notes = ? WHERE id = ?", (name, notes, session_id))
            elif name is not None:
                self._conn.execute("UPDATE sessions SET name = ? WHERE id = ?", (name, session_id))
            elif notes is not None:
                self._conn.execute("UPDATE sessions SET notes = ? WHERE id = ?", (notes, session_id))
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None
            res = dict(row)
            res["is_active"] = bool(res["is_active"])
            return res

    async def delete_session(self, session_id: int) -> bool:
        return await asyncio.get_running_loop().run_in_executor(None, self._delete_session_sync, session_id)

    def _delete_session_sync(self, session_id: int) -> bool:
        with self._lock:
            row = self._conn.execute("SELECT is_active FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return False
            was_active = bool(row["is_active"])
            self._conn.execute("DELETE FROM logs WHERE session_id = ?", (session_id,))
            self._conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            self._conn.commit()
            return True

    # =========================================================================
    # Device and Log Methods
    # =========================================================================

    async def load_all(self, session_id: int | None = None) -> tuple[dict, dict]:
        return await asyncio.get_running_loop().run_in_executor(None, self._load_all_sync, session_id)

    def _load_all_sync(self, session_id: int | None = None) -> tuple[dict, dict]:
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
            if session_id is None:
                return devices, logs

            for row in self._conn.execute(
                "SELECT device_id, payload FROM logs WHERE session_id = ? ORDER BY id",
                (session_id,)
            ):
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

    def _extract_item_fields(self, item: dict) -> tuple[str | None, float | None, float | None, int | None, float | None]:
        t = item.get("type")
        mag = None
        if t == "imu" and "aX" in item and "aY" in item and "aZ" in item:
            try:
                mag = math.sqrt(float(item["aX"])**2 + float(item["aY"])**2 + float(item["aZ"])**2)
            except Exception:
                mag = None
        elif t == "impact":
            mag = float(item.get("impact_value", 0)) if item.get("impact_value") is not None else None
        temp = float(item["temp"]) if item.get("temp") is not None else None
        pct = int(item["percentage"]) if item.get("percentage") is not None else None
        v = float(item["voltage"]) if item.get("voltage") is not None else None
        return t, mag, temp, pct, v

    async def append_log(self, device_id: str, item: dict, session_id: int | None = None) -> None:
        await asyncio.get_running_loop().run_in_executor(None, self._append_log_sync, device_id, item, session_id)

    def _append_log_sync(self, device_id: str, item: dict, session_id: int | None = None) -> None:
        with self._lock:
            if session_id is None:
                active = self._get_active_session_sync()
                if not active:
                    return
                session_id = active["id"]

            t, mag, temp, pct, v = self._extract_item_fields(item)
            self._conn.execute(
                """
                INSERT INTO logs (session_id, device_id, msg_type, mag, temp, battery_pct, battery_v, timestamp, payload) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, device_id, t, mag, temp, pct, v, item.get("timestamp"), json.dumps(item)),
            )
            self._conn.commit()

    async def append_logs_batch(self, entries: list[tuple[str, dict, int | None]]) -> None:
        await asyncio.get_running_loop().run_in_executor(None, self._append_logs_batch_sync, entries)

    def _append_logs_batch_sync(self, entries: list[tuple[str, dict, int | None]]) -> None:
        with self._lock:
            active = self._get_active_session_sync()
            default_session_id = active["id"] if active else None
            data_to_insert = []
            for dev_id, item, session_id in entries:
                s_id = session_id if session_id is not None else default_session_id
                if s_id is None:
                    continue
                t, mag, temp, pct, v = self._extract_item_fields(item)
                data_to_insert.append((
                    s_id,
                    dev_id,
                    t,
                    mag,
                    temp,
                    pct,
                    v,
                    item.get("timestamp"),
                    json.dumps(item),
                ))
            if not data_to_insert:
                return
            self._conn.executemany(
                """
                INSERT INTO logs (session_id, device_id, msg_type, mag, temp, battery_pct, battery_v, timestamp, payload) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                data_to_insert,
            )
            self._conn.commit()

    async def get_device_logs(
        self, device_id: str, session_id: int | None = None, limit: int = 50000
    ) -> list[dict]:
        return await asyncio.get_running_loop().run_in_executor(
            None, self._get_device_logs_sync, device_id, session_id, limit
        )

    def _get_device_logs_sync(
        self, device_id: str, session_id: int | None = None, limit: int = 50000
    ) -> list[dict]:
        with self._lock:
            if session_id is None:
                active = self._get_active_session_sync()
                if not active:
                    return []
                session_id = active["id"]

            rows = self._conn.execute(
                """
                SELECT payload FROM logs 
                WHERE session_id = ? AND device_id = ? 
                ORDER BY id ASC LIMIT ?
                """,
                (session_id, device_id, limit),
            ).fetchall()
            return [json.loads(row["payload"]) for row in rows]

    async def get_device_raw_json_logs(
        self, device_id: str, session_id: int | None = None, limit: int = 50000
    ) -> str:
        """Ultra-fast retrieval: returns JSON text directly to avoid Python object deserialization/serialization."""
        return await asyncio.get_running_loop().run_in_executor(
            None, self._get_device_raw_json_logs_sync, device_id, session_id, limit
        )

    def _get_device_raw_json_logs_sync(
        self, device_id: str, session_id: int | None = None, limit: int = 50000
    ) -> str:
        with self._lock:
            if session_id is None:
                active = self._get_active_session_sync()
                if not active:
                    return "[]"
                session_id = active["id"]

            rows = self._conn.execute(
                """
                SELECT payload FROM logs 
                WHERE session_id = ? AND device_id = ? 
                ORDER BY id ASC LIMIT ?
                """,
                (session_id, device_id, limit),
            ).fetchall()
            if not rows:
                return "[]"
            return "[" + ",".join(row["payload"] for row in rows) + "]"

    async def get_session_summary(self, session_id: int) -> dict:
        return await asyncio.get_running_loop().run_in_executor(None, self._get_session_summary_sync, session_id)

    def _get_session_summary_sync(self, session_id: int) -> dict:
        with self._lock:
            session_row = self._conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)) .fetchone()
            if not session_row:
                return {}
            
            session_info = dict(session_row)
            session_info["is_active"] = bool(session_info["is_active"])

            # High performance aggregated SQL query
            query = """
                SELECT 
                    l.device_id,
                    d.label_name,
                    d.label_number,
                    COALESCE(d.impact_threshold, ?) as impact_threshold,
                    MAX(COALESCE(l.mag, 0.0)) as max_g,
                    COUNT(CASE WHEN l.msg_type = 'impact' THEN 1 END) as impact_count,
                    COUNT(l.id) as sample_count,
                    MAX(l.timestamp) as last_update,
                    (SELECT temp FROM logs l2 WHERE l2.session_id = l.session_id AND l2.device_id = l.device_id AND l2.temp IS NOT NULL ORDER BY id DESC LIMIT 1) as last_temp,
                    (SELECT battery_pct FROM logs l3 WHERE l3.session_id = l.session_id AND l3.device_id = l.device_id AND l3.battery_pct IS NOT NULL ORDER BY id DESC LIMIT 1) as last_battery_pct,
                    (SELECT battery_v FROM logs l4 WHERE l4.session_id = l.session_id AND l4.device_id = l.device_id AND l4.battery_v IS NOT NULL ORDER BY id DESC LIMIT 1) as last_battery_v
                FROM logs l
                LEFT JOIN devices d ON l.device_id = d.device_id
                WHERE l.session_id = ?
                GROUP BY l.device_id
                ORDER BY d.label_number ASC, l.device_id ASC
            """
            rows = self._conn.execute(query, (DEFAULT_IMPACT_THRESHOLD, session_id)).fetchall()

            player_summaries = []
            for r in rows:
                player_summaries.append({
                    "device_id": r["device_id"],
                    "device_name": r["label_name"] or r["device_id"],
                    "label_name": r["label_name"],
                    "label_number": r["label_number"],
                    "impact_threshold": r["impact_threshold"],
                    "max_g": r["max_g"] or 0.0,
                    "impact_count": r["impact_count"] or 0,
                    "impact_alert": (r["impact_count"] or 0) > 0,
                    "sample_count": r["sample_count"],
                    "last_update": r["last_update"],
                    "temp": r["last_temp"],
                    "battery_percentage": r["last_battery_pct"],
                    "battery_voltage": r["last_battery_v"],
                    "connected": session_info["is_active"],
                })

            return {
                "session": session_info,
                "players": player_summaries,
            }

    async def close(self) -> None:
        await asyncio.get_running_loop().run_in_executor(None, self._conn.close)

