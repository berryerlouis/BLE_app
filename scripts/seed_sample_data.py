"""Populate data.db with sample match sessions, devices and logs so the dashboard
and historical replay can be previewed without real BLE hardware connected.

Usage:
    python scripts/seed_sample_data.py [--reset]
"""
from __future__ import annotations

import argparse
import math
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ble_central.db import DEFAULT_IMPACT_THRESHOLD, Database  # noqa: E402

DB_PATH = ROOT / "data.db"

# (MAC address used as device_id, display name, player name, jersey number, impact threshold (g))
DEVICES = [
    ("AA:BB:CC:11:22:33", "IMU Capture #1", "Martin", 7, DEFAULT_IMPACT_THRESHOLD),
    ("AA:BB:CC:44:55:66", "IMU Capture #2", "Bernard", 10, DEFAULT_IMPACT_THRESHOLD),
    ("AA:BB:CC:77:88:99", "IMU Capture #3", "Dubois", 4, DEFAULT_IMPACT_THRESHOLD),
    ("AA:BB:CC:AA:BB:CC", "IMU Capture #4", "Diallo", 23, DEFAULT_IMPACT_THRESHOLD),
    ("AA:BB:CC:DD:EE:FF", "IMU Capture #5", "Moreau", 9, DEFAULT_IMPACT_THRESHOLD),
    ("AA:BB:CC:12:34:56", "IMU Capture #6", "Petit", 15, DEFAULT_IMPACT_THRESHOLD),
]
POINTS_PER_DEVICE = 80
INTERVAL_S = 4  # seconds between samples


def build_logs(
    device_id: str, device_name: str, start_time: float, count: int, spike_index: int | None = None
) -> list[dict]:
    entries: list[dict] = []
    battery_pct = 100
    for i in range(count):
        ts = start_time + i * INTERVAL_S
        phase = i / 8
        if spike_index is not None and i == spike_index:
            # Hard impact: acceleration vector magnitude well above threshold (> 10g)
            aX, aY, aZ = 6.8, -6.5, 6.0
        else:
            aX = round(math.sin(phase) * 0.45, 4)
            aY = round(math.cos(phase) * 0.45, 4)
            aZ = round(0.98 + random.uniform(-0.03, 0.03), 4)
        entries.append(
            {
                "type": "imu",
                "timestamp": ts,
                "device_id": device_id,
                "device_name": device_name,
                "aX": aX,
                "aY": aY,
                "aZ": aZ,
                "gX": round(random.uniform(-4, 4), 4),
                "gY": round(random.uniform(-4, 4), 4),
                "gZ": round(random.uniform(-4, 4), 4),
                "temp": round(21.5 + math.sin(phase / 4) * 2, 2),
            }
        )
        if spike_index is not None and i == spike_index:
            mag = math.sqrt(aX**2 + aY**2 + aZ**2)
            entries.append(
                {
                    "type": "impact",
                    "timestamp": ts,
                    "device_id": device_id,
                    "impact_value": mag,
                    "impact_threshold": DEFAULT_IMPACT_THRESHOLD,
                }
            )
        if i % 12 == 0:
            battery_pct = max(0, 100 - int(i / count * 35))
            entries.append(
                {
                    "type": "battery",
                    "timestamp": ts,
                    "device_id": device_id,
                    "device_name": device_name,
                    "voltage": round(4.2 - (i / count) * 0.5, 3),
                    "percentage": battery_pct,
                }
            )
    return entries


def summary_from_logs(
    device_id: str, device_name: str, label_name: str, label_number: int, impact_threshold: float, logs: list[dict]
) -> dict:
    summary = {
        "device_id": device_id,
        "device_name": device_name,
        "connected": True,
        "label_name": label_name,
        "label_number": label_number,
        "impact_threshold": impact_threshold,
        "impact_alert": False,
    }
    for item in logs:
        summary["last_update"] = item["timestamp"]
        if item["type"] == "imu":
            summary.update({k: item[k] for k in ("aX", "aY", "aZ", "gX", "gY", "gZ", "temp")})
            magnitude = math.sqrt(item["aX"] ** 2 + item["aY"] ** 2 + item["aZ"] ** 2)
            if magnitude >= impact_threshold and not summary["impact_alert"]:
                summary["impact_alert"] = True
                summary["impact_value"] = magnitude
        elif item["type"] == "battery":
            summary["battery_voltage"] = item["voltage"]
            summary["battery_percentage"] = item["percentage"]
        elif item["type"] == "impact":
            summary["impact_alert"] = True
            summary["impact_value"] = item.get("impact_value")
    return summary


async def seed(reset: bool) -> None:
    db = Database(DB_PATH)
    if reset:
        with db._lock:
            db._conn.execute("DELETE FROM logs")
            db._conn.execute("DELETE FROM devices")
            db._conn.execute("DELETE FROM sessions")
            db._conn.commit()

    now = time.time()

    # Define 3 match sessions (2 historical archived, 1 live)
    session_definitions = [
        {
            "name": "Match 1 - vs Stade Toulousain (Passé)",
            "notes": "Victoire 24 - 18. Match intense, plusieurs chocs enregistrés.",
            "start_offset": -86400 * 3,  # 3 days ago
            "duration": 4800,  # 80 min
            "is_active": False,
            "spike_dev_index": 2,  # Dubois (#4) had a shock
        },
        {
            "name": "Match 2 - vs Racing 92 (Passé)",
            "notes": "Match nul 15 - 15. Conditions humides, température fraîche.",
            "start_offset": -86400 * 1,  # yesterday
            "duration": 4800,
            "is_active": False,
            "spike_dev_index": 4,  # Moreau (#9) had a shock
        },
        {
            "name": "Match 3 - Match en direct (Live)",
            "notes": "Session en cours de jeu. Surveillance temps réel.",
            "start_offset": - (POINTS_PER_DEVICE * INTERVAL_S),  # recent
            "duration": None,
            "is_active": True,
            "spike_dev_index": 3,  # Diallo (#23) has a recent shock
        },
    ]

    for s_def in session_definitions:
        sess = await db.create_session(
            name=s_def["name"],
            notes=s_def["notes"],
            set_active=s_def["is_active"],
        )
        s_id = sess["id"]
        start_ts = now + s_def["start_offset"]
        if s_def["duration"]:
            await db.end_session(s_id)

        all_session_entries = []
        for idx, (device_id, device_name, label_name, label_number, impact_threshold) in enumerate(DEVICES):
            has_spike = (idx == s_def["spike_dev_index"])
            spike_idx = POINTS_PER_DEVICE - 10 if has_spike else None
            logs = build_logs(device_id, device_name, start_ts, POINTS_PER_DEVICE, spike_idx)

            if s_def["is_active"]:
                summary = summary_from_logs(device_id, device_name, label_name, label_number, impact_threshold, logs)
                await db.save_device(device_id, summary)

            for item in logs:
                all_session_entries.append((device_id, item, s_id))

        await db.append_logs_batch(all_session_entries)

    # Re-activate the 3rd session as default live session
    sessions = await db.list_sessions()
    active_s = next((s for s in sessions if "Live" in s["name"]), sessions[0])
    await db.activate_session(active_s["id"])

    await db.close()
    print(f"Seeded {len(session_definitions)} match sessions and {len(DEVICES)} devices into {DB_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true", help="Delete existing data.db before seeding")
    args = parser.parse_args()

    import asyncio

    asyncio.run(seed(args.reset))


if __name__ == "__main__":
    main()
