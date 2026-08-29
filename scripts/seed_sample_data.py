"""Populate data.db with sample devices/logs so the dashboard can be previewed
without real BLE hardware connected.

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

# (MAC address used as device_id, display name, player name, jersey number, impact threshold (g), impact spike)
# One player (Diallo, #23) gets a late spike above their threshold to exercise the impact alert.
DEVICES = [
    ("AA:BB:CC:11:22:33", "IMU Capture #1", "Martin", 7, DEFAULT_IMPACT_THRESHOLD, False),
    ("AA:BB:CC:44:55:66", "IMU Capture #2", "Bernard", 10, DEFAULT_IMPACT_THRESHOLD, False),
    ("AA:BB:CC:77:88:99", "IMU Capture #3", "Dubois", 4, DEFAULT_IMPACT_THRESHOLD, False),
    ("AA:BB:CC:AA:BB:CC", "IMU Capture #4", "Diallo", 23, DEFAULT_IMPACT_THRESHOLD, True),
    ("AA:BB:CC:DD:EE:FF", "IMU Capture #5", "Moreau", 9, DEFAULT_IMPACT_THRESHOLD, False),
    ("AA:BB:CC:12:34:56", "IMU Capture #6", "Petit", 15, DEFAULT_IMPACT_THRESHOLD, False),
]
POINTS_PER_DEVICE = 120
INTERVAL_S = 5  # seconds between samples
SPIKE_INDEX = POINTS_PER_DEVICE - 5  # index of the impact spike, near the end of the log


def build_logs(device_id: str, device_name: str, now: float, spike: bool) -> list[dict]:
    entries: list[dict] = []
    start = now - POINTS_PER_DEVICE * INTERVAL_S
    battery_pct = 100
    for i in range(POINTS_PER_DEVICE):
        ts = start + i * INTERVAL_S
        phase = i / 10
        if spike and i == SPIKE_INDEX:
            # Hard impact: acceleration vector magnitude well above the default 8g threshold.
            aX, aY, aZ = 6.5, -6.0, 5.5
        else:
            aX = round(math.sin(phase) * 0.5, 4)
            aY = round(math.cos(phase) * 0.5, 4)
            aZ = round(0.98 + random.uniform(-0.02, 0.02), 4)
        entries.append(
            {
                "type": "imu",
                "timestamp": ts,
                "device_id": device_id,
                "device_name": device_name,
                "aX": aX,
                "aY": aY,
                "aZ": aZ,
                "gX": round(random.uniform(-5, 5), 4),
                "gY": round(random.uniform(-5, 5), 4),
                "gZ": round(random.uniform(-5, 5), 4),
                "temp": round(22 + math.sin(phase / 3) * 2, 2),
            }
        )
        if i % 10 == 0:
            entries.append(
                {
                    "type": "battery_voltage",
                    "timestamp": ts,
                    "device_id": device_id,
                    "device_name": device_name,
                    "voltage": round(4.2 - (i / POINTS_PER_DEVICE) * 0.6, 3),
                }
            )
            battery_pct = max(0, 100 - int(i / POINTS_PER_DEVICE * 40))
            entries.append(
                {
                    "type": "battery_level",
                    "timestamp": ts,
                    "device_id": device_id,
                    "device_name": device_name,
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
        elif item["type"] == "battery_voltage":
            summary["battery_voltage"] = item["voltage"]
        elif item["type"] == "battery_level":
            summary["battery_percentage"] = item["percentage"]
    return summary


async def seed(reset: bool) -> None:
    if reset and DB_PATH.exists():
        DB_PATH.unlink()

    db = Database(DB_PATH)
    now = time.time()
    for device_id, device_name, label_name, label_number, impact_threshold, spike in DEVICES:
        logs = build_logs(device_id, device_name, now, spike)
        summary = summary_from_logs(device_id, device_name, label_name, label_number, impact_threshold, logs)
        await db.save_device(device_id, summary)
        for item in logs:
            await db.append_log(device_id, item)
    await db.close()
    print(f"Seeded {len(DEVICES)} device(s) into {DB_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true", help="Delete existing data.db before seeding")
    args = parser.parse_args()

    import asyncio

    asyncio.run(seed(args.reset))


if __name__ == "__main__":
    main()
