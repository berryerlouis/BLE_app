"""Entry point: loads config, starts the BLE central and the web dashboard together."""
from __future__ import annotations

import asyncio
import logging
import signal
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


def create_ble_managers(ble_config: dict, data_queue: "asyncio.Queue[dict]") -> list[DeviceManager]:
    """Create one independent scanner/connection pool per explicitly configured adapter."""
    configured_adapters = ble_config.get("adapters")
    if not configured_adapters:
        return [DeviceManager(ble_config, data_queue)]

    adapters = list(dict.fromkeys(adapter for adapter in configured_adapters if adapter))
    if not adapters:
        raise ValueError("ble.adapters must contain at least one Bluetooth adapter")

    return [
        DeviceManager(
            {
                **ble_config,
                "adapter": adapter,
                "fallback_adapter": None,
                "adapter_index": index,
                "adapter_count": len(adapters),
            },
            data_queue,
        )
        for index, adapter in enumerate(adapters)
    ]


async def main() -> None:
    config = load_config()
    telemetry_config = config.get("telemetry", {})
    data_queue: "asyncio.Queue[dict]" = asyncio.Queue(
        maxsize=telemetry_config.get("queue_maxsize", 5000)
    )

    ble_managers = create_ble_managers(config["ble"], data_queue)
    db_path = config.get("database", {}).get("path")
    db_path = (CONFIG_PATH.parent / db_path).resolve() if db_path else DEFAULT_DB_PATH
    app = create_app(
        data_queue,
        db_path=db_path,
        logs_dir=LOGS_DIR,
        telemetry_config=telemetry_config,
    )
    restart_requested = asyncio.Event()
    shutdown_requested = asyncio.Event()
    app["request_restart"] = restart_requested
    loop = asyncio.get_running_loop()
    for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(shutdown_signal, shutdown_requested.set)
        except NotImplementedError:
            pass

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, config["web"]["host"], config["web"]["port"])
    await site.start()
    log.info("Web dashboard available at http://%s:%s", config["web"]["host"], config["web"]["port"])

    ble_tasks = [asyncio.create_task(manager.run_forever()) for manager in ble_managers]
    log.info("Started %d BLE adapter manager(s)", len(ble_managers))

    restart_task = asyncio.create_task(restart_requested.wait())
    shutdown_task = asyncio.create_task(shutdown_requested.wait())
    try:
        done, _ = await asyncio.wait(
            (*ble_tasks, restart_task, shutdown_task), return_when=asyncio.FIRST_COMPLETED
        )
        if restart_task in done:
            log.info("Graceful restart requested; disconnecting BLE satellites.")
        elif shutdown_task in done:
            log.info("Graceful shutdown requested; disconnecting BLE satellites.")
        else:
            log.error("A BLE adapter manager stopped; disconnecting all satellites.")
    except asyncio.CancelledError:
        pass
    finally:
        for manager in ble_managers:
            manager.stop()
        restart_task.cancel()
        shutdown_task.cancel()
        await asyncio.gather(*ble_tasks, restart_task, shutdown_task, return_exceptions=True)
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Shutting down.")
