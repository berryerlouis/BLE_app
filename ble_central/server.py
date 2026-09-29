"""aiohttp web server: serves the static dashboard, tracks per-device state/logs by session,
and broadcasts live BLE data over a websocket so several satellites can be shown at once.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import time
import zipfile
from collections import deque
from pathlib import Path

from aiohttp import WSMsgType, web

from . import firmware, update
from .db import Database, DEFAULT_DB_PATH, DEFAULT_IMPACT_THRESHOLD, DEFAULT_ROTATION_THRESHOLD

log = logging.getLogger("web_server")
user_action_log = logging.getLogger("user_actions")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
DEFAULT_LOGS_DIR = Path(__file__).resolve().parent.parent / "logs"
MAX_LOG_ENTRIES_PER_DEVICE = 2000
MAX_IMPACT_THRESHOLD = 200.0
MAX_ROTATION_THRESHOLD = 2000.0


def create_app(
    data_queue: "asyncio.Queue[dict]",
    db_path: Path | str = DEFAULT_DB_PATH,
    logs_dir: Path | str = DEFAULT_LOGS_DIR,
) -> web.Application:
    app = web.Application(middlewares=[_user_action_middleware])
    app["websockets"] = set()
    app["data_queue"] = data_queue
    app["db_queue"] = asyncio.Queue()
    app["logs_dir"] = Path(logs_dir)
    app["db_path"] = Path(db_path)
    app["devices"] = {}  # device_id -> summary dict
    app["logs"] = {}  # device_id -> deque of raw messages for active session
    app["active_session"] = None
    app["db"] = Database(db_path)
    app["firmware_lock"] = asyncio.Lock()
    firmware.ensure_firmware_dir()

    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", websocket_handler)
    
    # Device routes
    app.router.add_get("/api/devices", list_devices_handler)
    app.router.add_get("/api/devices/{device_id}/log", device_log_handler)
    app.router.add_post("/api/devices/{device_id}/label", set_device_label_handler)
    app.router.add_post("/api/devices/{device_id}/threshold", set_device_threshold_handler)
    app.router.add_post("/api/devices/{device_id}/rotation-threshold", set_device_rotation_threshold_handler)
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

    # Satellite firmware (USB flashing)
    app.router.add_get("/api/firmware", list_firmware_handler)
    app.router.add_post("/api/firmware/upload", upload_firmware_handler)
    app.router.add_delete("/api/firmware/{filename}", delete_firmware_handler)
    app.router.add_get("/api/firmware/ports", list_serial_ports_handler)
    app.router.add_post("/api/firmware/flash", flash_firmware_handler)
    app.router.add_post("/api/firmware/flash-all", flash_all_firmware_handler)

    # Diagnostics: lets someone on-site export logs/db for offline analysis once the Pi
    # is deployed and no longer reachable over SSH.
    app.router.add_get("/api/logs/export", export_logs_handler)

    app.router.add_static("/static/", STATIC_DIR, show_index=False, name="static")

    app.on_startup.append(_load_persisted_state)
    app.on_startup.append(_start_broadcaster)
    app.on_startup.append(_start_db_writer)
    app.on_cleanup.append(_stop_db_writer)
    app.on_cleanup.append(_stop_broadcaster)
    app.on_shutdown.append(_close_websockets)
    app.on_cleanup.append(_close_db)
    return app


@web.middleware
async def _user_action_middleware(request: web.Request, handler):
    """Records every state-changing user action (button clicks, label edits, session
    changes, etc.) to a dedicated log file so they can be reviewed after the fact.
    GETs to noisy/read-only endpoints (polling, static assets, websocket) are skipped.
    """
    path = request.path
    is_noisy = (
        request.method == "GET"
        and (path.startswith("/static/") or path == "/ws" or path == "/" or path.endswith("/log"))
    )
    response = await handler(request)
    if not is_noisy:
        user_action_log.info(
            "%s %s -> %s (from %s)", request.method, path, response.status, request.remote
        )
    return response


async def export_logs_handler(request: web.Request) -> web.StreamResponse:
    """Zips up the application/user-action logs and the SQLite database so someone on-site
    can download and send them back for offline retesting/analysis (no remote access needed).
    """
    logs_dir: Path = request.app["logs_dir"]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        if logs_dir.is_dir():
            for log_file in sorted(logs_dir.glob("*.log*")):
                zf.write(log_file, arcname=f"logs/{log_file.name}")
        db_path: Path = request.app["db_path"]
        if db_path.is_file():
            zf.write(db_path, arcname=db_path.name)
    buffer.seek(0)

    filename = f"ble_app_logs_{time.strftime('%Y%m%d_%H%M%S')}.zip"
    return web.Response(
        body=buffer.getvalue(),
        content_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _load_persisted_state(app: web.Application) -> None:
    await app["db"].end_active_sessions()
    app["active_session"] = None

    devices, logs = await app["db"].load_all()
    # No BLE link exists yet right after a (re)start: persisted "connected" flags are stale
    # (the process may have crashed/restarted mid-connection), so force everyone offline until
    # the scanner actually re-establishes a live session for each satellite.
    for summary in devices.values():
        summary["connected"] = False
        summary["state"] = "disconnected"
        # The firmware/ folder may have changed (git pull, manual copy) since the last run.
        _refresh_firmware_status(summary)
    app["devices"] = devices
    app["logs"] = {}
    for device_id, entries in logs.items():
        app["logs"][device_id] = deque(entries, maxlen=MAX_LOG_ENTRIES_PER_DEVICE)
    log.info(
        "Loaded %d device(s) from database without an active session",
        len(devices),
    )


async def _close_db(app: web.Application) -> None:
    await app["db"].close()


async def index_handler(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


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
    summary = devices.setdefault(device_id, {"device_id": device_id, "connected": False, "state": "disconnected"})
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
    summary = devices.setdefault(device_id, {"device_id": device_id, "connected": False, "state": "disconnected"})
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


async def set_device_rotation_threshold_handler(request: web.Request) -> web.Response:
    device_id = request.match_info["device_id"]
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Corps JSON invalide"}, status=400)

    try:
        threshold = float(body.get("threshold"))
    except (TypeError, ValueError):
        return web.json_response({"error": "Le seuil doit être un nombre"}, status=400)
    if not 0 < threshold <= MAX_ROTATION_THRESHOLD:
        return web.json_response(
            {"error": f"Le seuil doit être compris entre 0 et {MAX_ROTATION_THRESHOLD:g} deg/s"}, status=400
        )

    devices = request.app["devices"]
    summary = devices.setdefault(device_id, {"device_id": device_id, "connected": False, "state": "disconnected"})
    summary["rotation_threshold"] = threshold
    await request.app["db"].save_device(device_id, summary)

    await _broadcast_message(
        request.app,
        {
            "type": "rotation_threshold",
            "device_id": device_id,
            "rotation_threshold": threshold,
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
    summary["rotation_alert"] = False
    summary.pop("rotation_value", None)
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
        dev["rotation_alert"] = False
        dev.pop("rotation_value", None)

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
    active_session = request.app["active_session"]
    _, logs = await request.app["db"].load_all(session_id=active_session["id"] if active_session else None)
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
    request_restart = _request.app.get("request_restart")
    if request_restart:
        # Let aiohttp flush this response before the main process closes the BLE links.
        asyncio.get_running_loop().call_later(1.0, request_restart.set)
    return web.json_response(result)


# =========================================================================
# Satellite Firmware Handlers (USB flashing)
# =========================================================================

async def list_firmware_handler(_request: web.Request) -> web.Response:
    return web.json_response(firmware.list_firmware())


async def upload_firmware_handler(request: web.Request) -> web.Response:
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "file":
        return web.json_response({"error": "Fichier manquant"}, status=400)

    filename = field.filename or "firmware.zip"
    data = await field.read(decode=False)
    try:
        saved_name = firmware.save_firmware(filename, data)
    except firmware.FlashError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    await _refresh_all_firmware_status(request.app)
    return web.json_response({"filename": saved_name, "size": len(data)}, status=201)


async def delete_firmware_handler(request: web.Request) -> web.Response:
    filename = request.match_info["filename"]
    if not firmware.delete_firmware(filename):
        return web.json_response({"error": "Firmware introuvable"}, status=404)
    await _refresh_all_firmware_status(request.app)
    return web.json_response({"success": True})


async def list_serial_ports_handler(_request: web.Request) -> web.Response:
    return web.json_response(firmware.list_serial_ports())


async def flash_firmware_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Corps JSON invalide"}, status=400)

    port = str(body.get("port", "")).strip()
    filename = str(body.get("filename", "")).strip()
    if not port or not filename:
        return web.json_response({"error": "Port et fichier firmware requis"}, status=400)

    zip_path = firmware.FIRMWARE_DIR / Path(filename).name
    if not zip_path.is_file():
        return web.json_response({"error": "Firmware introuvable"}, status=404)

    firmware_lock: asyncio.Lock = request.app["firmware_lock"]
    if firmware_lock.locked():
        return web.json_response({"error": "Une mise à jour est déjà en cours"}, status=409)
    await firmware_lock.acquire()

    app = request.app

    async def progress_cb(stage: str, message: str, percent: int | None) -> None:
        await _broadcast_message(app, {
            "type": "firmware_flash",
            "stage": stage,
            "message": message,
            "percent": percent,
            "port": port,
            "filename": filename,
            "timestamp": time.time(),
        })

    async def run_flash() -> None:
        try:
            await firmware.flash_firmware(port, zip_path, progress_cb)
        except firmware.FlashError as exc:
            log.warning("Firmware flash failed: %s", exc)
            await progress_cb("error", str(exc), None)
        except Exception:
            log.exception("Unexpected error flashing firmware")
            await progress_cb("error", "Erreur inattendue pendant la mise à jour", None)
        finally:
            firmware_lock.release()

    asyncio.create_task(run_flash())
    return web.json_response({"started": True}, status=202)


async def flash_all_firmware_handler(request: web.Request) -> web.Response:
    """Flash the selected package to every connected XIAO satellite.

    Bootloaders are entered one by one so each re-enumerated serial port remains associated
    with its original satellite. Once prepared, independent DFU transfers run concurrently.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Corps JSON invalide"}, status=400)

    filename = str(body.get("filename", "")).strip()
    if not filename:
        return web.json_response({"error": "Firmware requis"}, status=400)

    zip_path = firmware.FIRMWARE_DIR / Path(filename).name
    if not zip_path.is_file():
        return web.json_response({"error": "Firmware introuvable"}, status=404)

    ports = [port["device"] for port in firmware.list_serial_ports() if port["likely_satellite"]]
    if not ports:
        return web.json_response({"error": "Aucun satellite USB détecté"}, status=400)

    firmware_lock: asyncio.Lock = request.app["firmware_lock"]
    if firmware_lock.locked():
        return web.json_response({"error": "Une mise à jour est déjà en cours"}, status=409)
    await firmware_lock.acquire()
    app = request.app

    async def progress_cb(port: str, stage: str, message: str, percent: int | None) -> None:
        await _broadcast_message(app, {
            "type": "firmware_flash",
            "batch": True,
            "stage": stage,
            "message": message,
            "percent": percent,
            "port": port,
            "filename": filename,
            "timestamp": time.time(),
        })

    async def prepare_port(port: str) -> tuple[str, str] | None:
        try:
            bootloader_port = await firmware.prepare_flash(
                port, lambda stage, message, percent: progress_cb(port, stage, message, percent)
            )
            return port, bootloader_port
        except firmware.FlashError as exc:
            log.warning("Firmware bootloader preparation failed for %s: %s", port, exc)
            await progress_cb(port, "error", str(exc), None)
        except Exception:
            log.exception("Unexpected error preparing %s for firmware flash", port)
            await progress_cb(port, "error", "Erreur inattendue pendant la préparation", None)
        return None

    async def transfer_port(port: str, bootloader_port: str) -> None:
        try:
            await firmware.transfer_firmware(
                bootloader_port, zip_path,
                lambda stage, message, percent: progress_cb(port, stage, message, percent),
            )
        except firmware.FlashError as exc:
            log.warning("Firmware transfer failed for %s: %s", port, exc)
            await progress_cb(port, "error", str(exc), None)
        except Exception:
            log.exception("Unexpected error flashing %s", port)
            await progress_cb(port, "error", "Erreur inattendue pendant la mise à jour", None)

    async def run_flash_all() -> None:
        try:
            prepared = []
            for port in ports:
                result = await prepare_port(port)
                if result is not None:
                    prepared.append(result)
            await asyncio.gather(*(transfer_port(port, bootloader_port) for port, bootloader_port in prepared))
        finally:
            firmware_lock.release()

    asyncio.create_task(run_flash_all())
    return web.json_response({"started": True, "ports": ports}, status=202)


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


def _update_state(app: web.Application, item: dict) -> list[dict]:
    """Apply an incoming message to cached state and return any threshold alert events."""
    device_id = item.get("device_id")
    if not device_id:
        return []

    devices = app["devices"]
    summary = devices.setdefault(
        device_id,
        {"device_id": device_id, "device_name": item.get("device_name", device_id), "connected": False, "state": "disconnected"},
    )
    if item.get("device_name"):
        summary["device_name"] = item["device_name"]
    is_historical = bool(item.get("historical"))
    # Backfilled samples carry the timestamp of when they were recorded, not now:
    # don't let them make an actively-connected device look stale (or vice versa).
    if not is_historical:
        summary["last_update"] = item.get("timestamp")
    summary.setdefault("impact_threshold", DEFAULT_IMPACT_THRESHOLD)
    summary.setdefault("rotation_threshold", DEFAULT_ROTATION_THRESHOLD)

    # Attach current session_id to incoming item
    active_session = app.get("active_session")
    if active_session:
        item["session_id"] = active_session["id"]

    alert_events = []
    msg_type = item["type"]
    if msg_type == "status":
        summary["connected"] = item["connected"]
        # BLE lifecycle detail: advertising -> connecting -> connected -> subscribed (streaming),
        # falls back to "connected"/"disconnected" for satellites/clients that don't send it.
        summary["state"] = item.get("state") or ("connected" if item["connected"] else "disconnected")
    elif msg_type == "imu":
        # Keep the "live now" reading untouched when replaying an old, buffered sample.
        if not is_historical:
            summary.update({k: item[k] for k in ("aX", "aY", "aZ", "gX", "gY", "gZ", "temp")})
        magnitude = math.sqrt(item["aX"] ** 2 + item["aY"] ** 2 + item["aZ"] ** 2)
        if magnitude >= summary["impact_threshold"] and not summary.get("impact_alert"):
            summary["impact_alert"] = True
            summary["impact_value"] = magnitude
            alert_events.append({
                "type": "impact",
                "device_id": device_id,
                "session_id": active_session["id"] if active_session else None,
                "impact_value": magnitude,
                "impact_threshold": summary["impact_threshold"],
                "timestamp": item.get("timestamp", time.time()),
                "historical": is_historical,
            })
        rotation_magnitude = math.sqrt(item["gX"] ** 2 + item["gY"] ** 2 + item["gZ"] ** 2)
        if rotation_magnitude >= summary["rotation_threshold"] and not summary.get("rotation_alert"):
            summary["rotation_alert"] = True
            summary["rotation_value"] = rotation_magnitude
            alert_events.append({
                "type": "rotation",
                "device_id": device_id,
                "session_id": active_session["id"] if active_session else None,
                "rotation_value": rotation_magnitude,
                "rotation_threshold": summary["rotation_threshold"],
                "timestamp": item.get("timestamp", time.time()),
                "historical": is_historical,
            })
    elif msg_type == "battery":
        if not is_historical:
            if "voltage" in item:
                summary["battery_voltage"] = item["voltage"]
            if "percentage" in item:
                summary["battery_percentage"] = item["percentage"]
            if "charging" in item:
                summary["battery_charging"] = item["charging"]
    elif msg_type == "rssi":
        summary["rssi"] = item["rssi"]
    elif msg_type == "sync_status":
        # Progress of the satellite replaying data it buffered while disconnected.
        summary["backfilling"] = item.get("backfilling", False)
        summary["backfill_pending"] = item.get("pending_imu", 0) + item.get("pending_battery", 0)
    elif msg_type == "firmware_version":
        summary["firmware_version"] = item.get("version")
        _refresh_firmware_status(summary)

    log_buffer = app["logs"].setdefault(device_id, deque(maxlen=MAX_LOG_ENTRIES_PER_DEVICE))
    log_buffer.append(item)
    log_buffer.extend(alert_events)
    return alert_events


def _refresh_firmware_status(summary: dict) -> None:
    """Compares a device's last-reported firmware version against what's available in the
    firmware/ folder, so the dashboard can flag when a newer USB-flashable build exists.
    """
    latest = firmware.latest_firmware()
    latest_version = latest["version"] if latest else None
    summary["latest_firmware_version"] = latest_version
    summary["firmware_update_available"] = firmware.is_newer(summary.get("firmware_version"), latest_version)


async def _refresh_all_firmware_status(app: web.Application) -> None:
    """Re-evaluates firmware_update_available for every known device (e.g. after a new firmware
    package is uploaded/deleted) and persists + broadcasts the change.
    """
    for device_id, summary in app["devices"].items():
        _refresh_firmware_status(summary)
        await app["db"].save_device(device_id, summary)
        await _broadcast_message(
            app,
            {
                "type": "firmware_status",
                "device_id": device_id,
                "latest_firmware_version": summary.get("latest_firmware_version"),
                "firmware_update_available": summary.get("firmware_update_available", False),
                "timestamp": time.time(),
            },
        )


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
        alert_events = _update_state(app, item)
        device_id = item.get("device_id")
        if device_id:
            _persist_state(app, device_id, item)
        broadcast_item = item
        if item.get("type") == "firmware_version" and device_id:
            summary = app["devices"].get(device_id, {})
            broadcast_item = {
                **item,
                "latest_firmware_version": summary.get("latest_firmware_version"),
                "firmware_update_available": summary.get("firmware_update_available", False),
            }
        await _broadcast_message(app, broadcast_item)
        for alert_event in alert_events:
            if device_id:
                _persist_state(app, device_id, alert_event)
            await _broadcast_message(app, alert_event)


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

