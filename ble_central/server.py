"""aiohttp web server: serves the static dashboard, tracks per-device state/logs,
and broadcasts live BLE data over a websocket so several satellites can be shown at once.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections import deque
from pathlib import Path

from aiohttp import WSMsgType, web

from . import update
from .db import Database, DEFAULT_DB_PATH, DEFAULT_IMPACT_THRESHOLD

log = logging.getLogger("web_server")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
MAX_LOG_ENTRIES_PER_DEVICE = 2000
MAX_IMPACT_THRESHOLD = 200.0


def create_app(data_queue: "asyncio.Queue[dict]", db_path: Path | str = DEFAULT_DB_PATH) -> web.Application:
    app = web.Application()
    app["websockets"] = set()
    app["data_queue"] = data_queue
    app["devices"] = {}  # device_id -> summary dict
    app["logs"] = {}  # device_id -> deque of raw messages (most recent last)
    app["db"] = Database(db_path)

    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/api/devices", list_devices_handler)
    app.router.add_get("/api/devices/{device_id}/log", device_log_handler)
    app.router.add_post("/api/devices/{device_id}/label", set_device_label_handler)
    app.router.add_post("/api/devices/{device_id}/threshold", set_device_threshold_handler)
    app.router.add_post("/api/devices/{device_id}/impact/reset", reset_device_impact_handler)
    app.router.add_get("/api/version", version_handler)
    app.router.add_get("/api/update/check", update_check_handler)
    app.router.add_post("/api/update/apply", update_apply_handler)
    app.router.add_static("/static/", STATIC_DIR, show_index=False, name="static")

    app.on_startup.append(_load_persisted_state)
    app.on_startup.append(_start_broadcaster)
    app.on_cleanup.append(_stop_broadcaster)
    app.on_shutdown.append(_close_websockets)
    app.on_cleanup.append(_close_db)
    return app


async def _load_persisted_state(app: web.Application) -> None:
    devices, logs = await app["db"].load_all()
    app["devices"] = devices
    for device_id, entries in logs.items():
        app["logs"][device_id] = deque(entries, maxlen=MAX_LOG_ENTRIES_PER_DEVICE)
    log.info("Loaded %d device(s) from database", len(devices))


async def _close_db(app: web.Application) -> None:
    await app["db"].close()


async def index_handler(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html")


async def list_devices_handler(request: web.Request) -> web.Response:
    return web.json_response(list(request.app["devices"].values()))


async def device_log_handler(request: web.Request) -> web.Response:
    device_id = request.match_info["device_id"]
    log_buffer = request.app["logs"].get(device_id, deque())
    return web.json_response(list(log_buffer))


async def set_device_label_handler(request: web.Request) -> web.Response:
    device_id = request.match_info["device_id"]
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Corps JSON invalide"}, status=400)

    name = str(body.get("name", "")).strip()
    if not name:
        return web.json_response({"error": "Le nom est requis"}, status=400)
    try:
        number = int(body.get("number"))
    except (TypeError, ValueError):
        return web.json_response({"error": "Le numéro doit être un entier"}, status=400)
    if not 0 <= number <= 1000:
        return web.json_response({"error": "Le numéro doit être compris entre 0 et 1000"}, status=400)

    devices = request.app["devices"]
    summary = devices.setdefault(device_id, {"device_id": device_id, "connected": False})
    summary["label_name"] = name
    summary["label_number"] = number

    await request.app["db"].save_device(device_id, summary)

    await _broadcast_message(
        request.app,
        {
            "type": "label",
            "device_id": device_id,
            "label_name": name,
            "label_number": number,
            "timestamp": time.time(),
        },
    )
    return web.json_response(summary)


async def set_device_threshold_handler(request: web.Request) -> web.Response:
    device_id = request.match_info["device_id"]
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Corps JSON invalide"}, status=400)

    try:
        threshold = float(body.get("threshold"))
    except (TypeError, ValueError):
        return web.json_response({"error": "Le seuil doit être un nombre"}, status=400)
    if not 0 < threshold <= MAX_IMPACT_THRESHOLD:
        return web.json_response(
            {"error": f"Le seuil doit être compris entre 0 et {MAX_IMPACT_THRESHOLD:g} g"}, status=400
        )

    devices = request.app["devices"]
    summary = devices.setdefault(device_id, {"device_id": device_id, "connected": False})
    summary["impact_threshold"] = threshold
    await request.app["db"].save_device(device_id, summary)

    await _broadcast_message(
        request.app,
        {
            "type": "threshold",
            "device_id": device_id,
            "impact_threshold": threshold,
            "timestamp": time.time(),
        },
    )
    return web.json_response(summary)


async def reset_device_impact_handler(request: web.Request) -> web.Response:
    device_id = request.match_info["device_id"]
    devices = request.app["devices"]
    summary = devices.get(device_id)
    if summary is None:
        return web.json_response({"error": "Satellite inconnu"}, status=404)

    summary["impact_alert"] = False
    summary.pop("impact_value", None)
    await request.app["db"].save_device(device_id, summary)

    await _broadcast_message(
        request.app,
        {"type": "impact_reset", "device_id": device_id, "timestamp": time.time()},
    )
    return web.json_response(summary)


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


def _update_state(app: web.Application, item: dict) -> dict | None:
    """Apply an incoming message to the cached state; returns an impact event to broadcast, if any."""
    device_id = item.get("device_id")
    if not device_id:
        return None

    devices = app["devices"]
    summary = devices.setdefault(
        device_id, {"device_id": device_id, "device_name": item.get("device_name", device_id), "connected": False}
    )
    if item.get("device_name"):
        summary["device_name"] = item["device_name"]
    summary["last_update"] = item.get("timestamp")
    summary.setdefault("impact_threshold", DEFAULT_IMPACT_THRESHOLD)

    impact_event = None
    msg_type = item["type"]
    if msg_type == "status":
        summary["connected"] = item["connected"]
    elif msg_type == "imu":
        summary.update({k: item[k] for k in ("aX", "aY", "aZ", "gX", "gY", "gZ", "temp")})
        magnitude = math.sqrt(item["aX"] ** 2 + item["aY"] ** 2 + item["aZ"] ** 2)
        if magnitude >= summary["impact_threshold"] and not summary.get("impact_alert"):
            summary["impact_alert"] = True
            summary["impact_value"] = magnitude
            impact_event = {
                "type": "impact",
                "device_id": device_id,
                "impact_value": magnitude,
                "impact_threshold": summary["impact_threshold"],
                "timestamp": item.get("timestamp", time.time()),
            }
    elif msg_type == "battery_voltage":
        summary["battery_voltage"] = item["voltage"]
    elif msg_type == "battery_level":
        summary["battery_percentage"] = item["percentage"]

    log_buffer = app["logs"].setdefault(device_id, deque(maxlen=MAX_LOG_ENTRIES_PER_DEVICE))
    log_buffer.append(item)
    if impact_event:
        log_buffer.append(impact_event)
    return impact_event


def _persist_state(app: web.Application, device_id: str, item: dict) -> None:
    db: Database = app["db"]
    asyncio.create_task(_safe_persist(db, device_id, app["devices"][device_id], item))


async def _safe_persist(db: Database, device_id: str, summary: dict, item: dict) -> None:
    try:
        await db.save_device(device_id, summary)
        await db.append_log(device_id, item)
    except Exception:
        log.exception("Failed to persist data for %s", device_id)


async def _broadcast_message(app: web.Application, item: dict) -> None:
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


async def _broadcast_loop(app: web.Application) -> None:
    queue: "asyncio.Queue[dict]" = app["data_queue"]
    while True:
        item = await queue.get()
        impact_event = _update_state(app, item)
        device_id = item.get("device_id")
        if device_id:
            _persist_state(app, device_id, item)
        await _broadcast_message(app, item)
        if impact_event:
            if device_id:
                _persist_state(app, device_id, impact_event)
            await _broadcast_message(app, impact_event)


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
