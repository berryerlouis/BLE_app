"""aiohttp web server: serves the static dashboard, tracks per-device state/logs by session,
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
    app["db_queue"] = asyncio.Queue()
    app["devices"] = {}  # device_id -> summary dict
    app["logs"] = {}  # device_id -> deque of raw messages for active session
    app["active_session"] = None
    app["db"] = Database(db_path)

    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", websocket_handler)
    
    # Device routes
    app.router.add_get("/api/devices", list_devices_handler)
    app.router.add_get("/api/devices/{device_id}/log", device_log_handler)
    app.router.add_post("/api/devices/{device_id}/label", set_device_label_handler)
    app.router.add_post("/api/devices/{device_id}/threshold", set_device_threshold_handler)
    app.router.add_post("/api/devices/{device_id}/impact/reset", reset_device_impact_handler)

    # Session (Match) routes
    app.router.add_get("/api/sessions", list_sessions_handler)
    app.router.add_get("/api/sessions/active", active_session_handler)
    app.router.add_post("/api/sessions", create_session_handler)
    app.router.add_get("/api/sessions/{session_id}", get_session_handler)
    app.router.add_put("/api/sessions/{session_id}", update_session_handler)
    app.router.add_delete("/api/sessions/{session_id}", delete_session_handler)
    app.router.add_post("/api/sessions/{session_id}/activate", activate_session_handler)
    app.router.add_post("/api/sessions/{session_id}/end", end_session_handler)
    app.router.add_get("/api/sessions/{session_id}/summary", session_summary_handler)
    app.router.add_get("/api/sessions/{session_id}/devices/{device_id}/log", session_device_log_handler)

    # Version & Updates
    app.router.add_get("/api/version", version_handler)
    app.router.add_get("/api/update/check", update_check_handler)
    app.router.add_post("/api/update/apply", update_apply_handler)

    app.router.add_static("/static/", STATIC_DIR, show_index=False, name="static")

    app.on_startup.append(_load_persisted_state)
    app.on_startup.append(_start_broadcaster)
    app.on_startup.append(_start_db_writer)
    app.on_cleanup.append(_stop_db_writer)
    app.on_cleanup.append(_stop_broadcaster)
    app.on_shutdown.append(_close_websockets)
    app.on_cleanup.append(_close_db)
    return app


async def _load_persisted_state(app: web.Application) -> None:
    active_session = await app["db"].get_active_session()
    app["active_session"] = active_session

    devices, logs = await app["db"].load_all(session_id=active_session["id"])
    app["devices"] = devices
    app["logs"] = {}
    for device_id, entries in logs.items():
        app["logs"][device_id] = deque(entries, maxlen=MAX_LOG_ENTRIES_PER_DEVICE)
    log.info(
        "Loaded active session #%d ('%s') with %d device(s) from database",
        active_session["id"],
        active_session["name"],
        len(devices),
    )


async def _close_db(app: web.Application) -> None:
    await app["db"].close()


async def index_handler(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html")


async def list_devices_handler(request: web.Request) -> web.Response:
    session_id_str = request.query.get("session_id")
    active_session = request.app.get("active_session")
    
    if session_id_str:
        try:
            session_id = int(session_id_str)
            if active_session and session_id == active_session["id"]:
                return web.json_response(list(request.app["devices"].values()))
            
            summary = await request.app["db"].get_session_summary(session_id)
            return web.json_response(summary.get("players", []))
        except ValueError:
            return web.json_response({"error": "session_id invalide"}, status=400)

    return web.json_response(list(request.app["devices"].values()))


async def device_log_handler(request: web.Request) -> web.Response:
    device_id = request.match_info["device_id"]
    session_id_str = request.query.get("session_id")
    
    if session_id_str:
        try:
            session_id = int(session_id_str)
            raw_json = await request.app["db"].get_device_raw_json_logs(device_id, session_id=session_id)
            return web.Response(text=raw_json, content_type="application/json")
        except ValueError:
            return web.json_response({"error": "session_id invalide"}, status=400)

    # Active session logs: check if requesting historical or memory
    active_sess = request.app.get("active_session")
    if active_sess:
        raw_json = await request.app["db"].get_device_raw_json_logs(device_id, session_id=active_sess["id"])
        return web.Response(text=raw_json, content_type="application/json")

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


# =========================================================================
# Session Handlers (1 Session = 1 Match)
# =========================================================================

async def list_sessions_handler(request: web.Request) -> web.Response:
    sessions = await request.app["db"].list_sessions()
    return web.json_response(sessions)


async def active_session_handler(request: web.Request) -> web.Response:
    active = request.app.get("active_session")
    if not active:
        active = await request.app["db"].get_active_session()
        request.app["active_session"] = active
    return web.json_response(active)


async def create_session_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        body = {}

    name = str(body.get("name", "")).strip()
    if not name:
        name = f"Match {time.strftime('%d/%m/%Y %H:%M')}"
    notes = str(body.get("notes", "")).strip()

    new_session = await request.app["db"].create_session(name=name, notes=notes, set_active=True)
    request.app["active_session"] = new_session

    # Clear active in-memory log buffer for the new session
    request.app["logs"] = {}
    for dev in request.app["devices"].values():
        dev["impact_alert"] = False
        dev.pop("impact_value", None)

    await _broadcast_message(
        request.app,
        {
            "type": "session_created",
            "session": new_session,
            "timestamp": time.time(),
        },
    )
    return web.json_response(new_session, status=201)


async def get_session_handler(request: web.Request) -> web.Response:
    try:
        session_id = int(request.match_info["session_id"])
    except ValueError:
        return web.json_response({"error": "session_id invalide"}, status=400)

    session = await request.app["db"].get_session(session_id)
    if not session:
        return web.json_response({"error": "Session introuvable"}, status=404)
    return web.json_response(session)


async def update_session_handler(request: web.Request) -> web.Response:
    try:
        session_id = int(request.match_info["session_id"])
    except ValueError:
        return web.json_response({"error": "session_id invalide"}, status=400)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Corps JSON invalide"}, status=400)

    name = body.get("name")
    notes = body.get("notes")
    updated = await request.app["db"].update_session(session_id, name=name, notes=notes)
    if not updated:
        return web.json_response({"error": "Session introuvable"}, status=404)

    if request.app["active_session"] and request.app["active_session"]["id"] == session_id:
        request.app["active_session"] = updated

    await _broadcast_message(
        request.app,
        {"type": "session_updated", "session": updated, "timestamp": time.time()},
    )
    return web.json_response(updated)


async def activate_session_handler(request: web.Request) -> web.Response:
    try:
        session_id = int(request.match_info["session_id"])
    except ValueError:
        return web.json_response({"error": "session_id invalide"}, status=400)

    activated = await request.app["db"].activate_session(session_id)
    if not activated:
        return web.json_response({"error": "Session introuvable"}, status=404)

    request.app["active_session"] = activated
    # Reload in-memory log buffer for the newly activated session
    _, logs = await request.app["db"].load_all(session_id=session_id)
    request.app["logs"] = {}
    for device_id, entries in logs.items():
        request.app["logs"][device_id] = deque(entries, maxlen=MAX_LOG_ENTRIES_PER_DEVICE)

    await _broadcast_message(
        request.app,
        {"type": "session_activated", "session": activated, "timestamp": time.time()},
    )
    return web.json_response(activated)


async def end_session_handler(request: web.Request) -> web.Response:
    try:
        session_id = int(request.match_info["session_id"])
    except ValueError:
        return web.json_response({"error": "session_id invalide"}, status=400)

    ended = await request.app["db"].end_session(session_id)
    if not ended:
        return web.json_response({"error": "Session introuvable"}, status=404)

    if request.app["active_session"] and request.app["active_session"]["id"] == session_id:
        request.app["active_session"] = None
        request.app["logs"] = {}

    await _broadcast_message(
        request.app,
        {"type": "session_ended", "session": ended, "timestamp": time.time()},
    )
    return web.json_response(ended)


async def delete_session_handler(request: web.Request) -> web.Response:
    try:
        session_id = int(request.match_info["session_id"])
    except ValueError:
        return web.json_response({"error": "session_id invalide"}, status=400)

    success = await request.app["db"].delete_session(session_id)
    if not success:
        return web.json_response({"error": "Session introuvable"}, status=404)

    # Refresh active session
    request.app["active_session"] = await request.app["db"].get_active_session()
    _, logs = await request.app["db"].load_all(session_id=request.app["active_session"]["id"])
    request.app["logs"] = {}
    for device_id, entries in logs.items():
        request.app["logs"][device_id] = deque(entries, maxlen=MAX_LOG_ENTRIES_PER_DEVICE)

    await _broadcast_message(
        request.app,
        {
            "type": "session_deleted",
            "session_id": session_id,
            "active_session": request.app["active_session"],
            "timestamp": time.time(),
        },
    )
    return web.json_response({"success": True, "active_session": request.app["active_session"]})


async def session_summary_handler(request: web.Request) -> web.Response:
    try:
        session_id = int(request.match_info["session_id"])
    except ValueError:
        return web.json_response({"error": "session_id invalide"}, status=400)

    summary = await request.app["db"].get_session_summary(session_id)
    if not summary:
        return web.json_response({"error": "Session introuvable"}, status=404)
    return web.json_response(summary)


async def session_device_log_handler(request: web.Request) -> web.Response:
    try:
        session_id = int(request.match_info["session_id"])
    except ValueError:
        return web.json_response({"error": "session_id invalide"}, status=400)
    device_id = request.match_info["device_id"]

    raw_json = await request.app["db"].get_device_raw_json_logs(device_id, session_id=session_id)
    return web.Response(text=raw_json, content_type="application/json")


# =========================================================================
# Version and Update Handlers
# =========================================================================

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

    # Attach current session_id to incoming item
    active_session = app.get("active_session")
    if active_session:
        item["session_id"] = active_session["id"]

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
                "session_id": active_session["id"] if active_session else None,
                "impact_value": magnitude,
                "impact_threshold": summary["impact_threshold"],
                "timestamp": item.get("timestamp", time.time()),
            }
    elif msg_type == "battery":
        summary["battery_voltage"] = item["voltage"]
        summary["battery_percentage"] = item["percentage"]

    log_buffer = app["logs"].setdefault(device_id, deque(maxlen=MAX_LOG_ENTRIES_PER_DEVICE))
    log_buffer.append(item)
    if impact_event:
        log_buffer.append(impact_event)
    return impact_event


def _persist_state(app: web.Application, device_id: str, item: dict) -> None:
    active_session = app.get("active_session")
    session_id = active_session["id"] if active_session else None
    summary_copy = dict(app["devices"].get(device_id, {}))
    app["db_queue"].put_nowait((device_id, summary_copy, item, session_id))


async def _db_batch_writer(app: web.Application) -> None:
    """Efficient background worker that batches incoming device summaries and logs into SQLite."""
    db: Database = app["db"]
    queue: asyncio.Queue = app["db_queue"]

    while True:
        try:
            # Wait for the first item
            first_item = await queue.get()
            batch = [first_item]
            
            # Drain up to 200 items or 50ms timeout
            start_drain = time.monotonic()
            while len(batch) < 200 and (time.monotonic() - start_drain) < 0.05:
                try:
                    item = queue.get_nowait()
                    batch.append(item)
                except asyncio.QueueEmpty:
                    break

            # Deduplicate latest device summaries
            devices_to_save: dict[str, dict] = {}
            logs_to_append: list[tuple[str, dict, int | None]] = []

            for dev_id, summary, payload, sess_id in batch:
                if summary:
                    devices_to_save[dev_id] = summary
                logs_to_append.append((dev_id, payload, sess_id))

            # Batch execute in worker thread
            try:
                for dev_id, summary in devices_to_save.items():
                    await db.save_device(dev_id, summary)
                if logs_to_append:
                    await db.append_logs_batch(logs_to_append)
            except Exception:
                log.exception("Error in database batch writer")

            # Small yield to let event loop handle network/websocket packets
            await asyncio.sleep(0.01)

        except asyncio.CancelledError:
            # Drain remaining items on shutdown
            remaining_logs = []
            while not queue.empty():
                try:
                    dev_id, summary, payload, sess_id = queue.get_nowait()
                    if summary:
                        await db.save_device(dev_id, summary)
                    remaining_logs.append((dev_id, payload, sess_id))
                except Exception:
                    break
            if remaining_logs:
                await db.append_logs_batch(remaining_logs)
            break
        except Exception:
            log.exception("Unexpected error in DB writer loop")
            await asyncio.sleep(0.1)


async def _start_db_writer(app: web.Application) -> None:
    app["db_writer_task"] = asyncio.create_task(_db_batch_writer(app))


async def _stop_db_writer(app: web.Application) -> None:
    task = app.get("db_writer_task")
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


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

