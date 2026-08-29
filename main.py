"""Entry point: loads config, starts the BLE central and the web dashboard together."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import yaml
from aiohttp import web

from ble_central.ble_client import DeviceManager
from ble_central.server import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("main")

CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


async def main() -> None:
    config = load_config()
    data_queue: "asyncio.Queue[dict]" = asyncio.Queue()

    ble_manager = DeviceManager(config["ble"], data_queue)
    app = create_app(data_queue)

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
