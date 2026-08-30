"""Entry point: loads config, starts the BLE central and the web dashboard together."""
from __future__ import annotations

import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

import yaml
from aiohttp import web

from ble_central.ble_client import DeviceManager
from ble_central.db import DEFAULT_DB_PATH
from ble_central.server import create_app

CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"
LOGS_DIR = Path(__file__).resolve().parent / "logs"


def setup_logging() -> None:
    """Log to console (visible via `journalctl -u ble-central`) and to rotating files on disk,
    so logs survive after the Pi is deployed on-site and only remain reachable via the
    /api/logs/export download link (no SSH access once installed at a venue).
    """
    LOGS_DIR.mkdir(exist_ok=True)
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    file_handler = RotatingFileHandler(LOGS_DIR / "app.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(file_handler)
    root.addHandler(console_handler)


setup_logging()
log = logging.getLogger("main")


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


async def main() -> None:
    config = load_config()
    data_queue: "asyncio.Queue[dict]" = asyncio.Queue()

    ble_manager = DeviceManager(config["ble"], data_queue)
    db_path = config.get("database", {}).get("path")
    db_path = (CONFIG_PATH.parent / db_path).resolve() if db_path else DEFAULT_DB_PATH
    app = create_app(data_queue, db_path=db_path, logs_dir=LOGS_DIR)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, config["web"]["host"], config["web"]["port"])
    await site.start()
    log.info("Web dashboard available at http://%s:%s", config["web"]["host"], config["web"]["port"])

    ble_task = asyncio.create_task(ble_manager.run_forever())

    try:
        await ble_task
    except asyncio.CancelledError:
        pass
    finally:
        ble_manager.stop()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Shutting down.")
