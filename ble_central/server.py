"""aiohttp web server: serves the static dashboard, tracks per-device state/logs,
and broadcasts live BLE data over a websocket so several satellites can be shown at once.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from pathlib import Path

from aiohttp import WSMsgType, web

from . import update

log = logging.getLogger("web_server")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
MAX_LOG_ENTRIES_PER_DEVICE = 2000


def create_app(data_queue: "asyncio.Queue[dict]") -> web.Application:
    app = web.Application()
    app["websockets"] = set()
    app["data_queue"] = data_queue
    app["devices"] = {}  # device_id -> summary dict
    app["logs"] = {}  # device_id -> deque of raw messages (most recent last)

    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/api/devices", list_devices_handler)
    app.router.add_get("/api/devices/{device_id}/log", device_log_handler)
    app.router.add_get("/api/version", version_handler)
    app.router.add_get("/api/update/check", update_check_handler)
    app.router.add_post("/api/update/apply", update_apply_handler)
    app.router.add_static("/static/", STATIC_DIR, show_index=False, name="static")

    app.on_startup.append(_start_broadcaster)
    app.on_cleanup.append(_stop_broadcaster)
    app.on_shutdown.append(_close_websockets)
    return app


async def index_handler(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html")


async def list_devices_handler(request: web.Request) -> web.Response:
    return web.json_response(list(request.app["devices"].values()))


async def device_log_handler(request: web.Request) -> web.Response:
    device_id = request.match_info["device_id"]
    log_buffer = request.app["logs"].get(device_id, deque())
    return web.json_response(list(log_buffer))


async def version_handler(_request: web.Request) -> web.Response:
    return web.json_response({"version": update.read_local_version(), "author": update.AUTHOR})


async def update_check_handler(_request: web.Request) -> web.Response:
    return web.json_response(await update.check_update())


async def update_apply_handler(_request: web.Request) -> web.Response:
    try:
        result = await update.apply_update()
    except RuntimeError as exc:
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response(result)


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    request.app["websockets"].add(ws)
    log.info("Client connected (%d total)", len(request.app["websockets"]))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                log.warning("Websocket error: %s", ws.exception())
    finally:
        request.app["websockets"].discard(ws)
        log.info("Client disconnected (%d total)", len(request.app["websockets"]))
    return ws


def _update_state(app: web.Application, item: dict) -> None:
    device_id = item.get("device_id")
    if not device_id:
        return

    devices = app["devices"]
    summary = devices.setdefault(
        device_id, {"device_id": device_id, "device_name": item.get("device_name", device_id), "connected": False}
    )
    if item.get("device_name"):
        summary["device_name"] = item["device_name"]
    summary["last_update"] = item.get("timestamp")

    msg_type = item["type"]
    if msg_type == "status":
        summary["connected"] = item["connected"]
    elif msg_type == "imu":
        summary.update({k: item[k] for k in ("aX", "aY", "aZ", "gX", "gY", "gZ", "temp")})
    elif msg_type == "battery_voltage":
        summary["battery_voltage"] = item["voltage"]
    elif msg_type == "battery_level":
        summary["battery_percentage"] = item["percentage"]

    log_buffer = app["logs"].setdefault(device_id, deque(maxlen=MAX_LOG_ENTRIES_PER_DEVICE))
    log_buffer.append(item)


async def _broadcast_loop(app: web.Application) -> None:
    queue: "asyncio.Queue[dict]" = app["data_queue"]
    while True:
        item = await queue.get()
        _update_state(app, item)
        message = json.dumps(item)
        dead = []
        for ws in app["websockets"]:
            if ws.closed:
                dead.append(ws)
                continue
            try:
                await ws.send_str(message)
            except ConnectionResetError:
                dead.append(ws)
        for ws in dead:
            app["websockets"].discard(ws)


async def _start_broadcaster(app: web.Application) -> None:
    app["broadcaster_task"] = asyncio.create_task(_broadcast_loop(app))


async def _stop_broadcaster(app: web.Application) -> None:
    task: asyncio.Task = app["broadcaster_task"]
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def _close_websockets(app: web.Application) -> None:
    for ws in set(app["websockets"]):
        await ws.close(code=1001, message=b"Server shutdown")
