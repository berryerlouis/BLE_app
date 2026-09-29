"""USB firmware flashing for IMU_Capture satellites via the Adafruit/Nordic serial DFU bootloader.

Mirrors arduino-cli's own upload flow for the Seeed XIAO nRF52840 boards (1200bps touch to reset
into the bootloader, then serial DFU) so the same .zip package produced by compiling the firmware
("Arduino: Verify" task, which already emits an IMU_Capture.ino.zip DFU package) can be pushed to
a satellite plugged into this machine's USB port, straight from the app. No BLE/wireless OTA: the
satellite must be connected by USB cable for this.

Requires the `adafruit-nrfutil` and `pyserial` packages (see requirements.txt).
"""
from __future__ import annotations

import asyncio
import logging
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger("firmware")

FIRMWARE_DIR = Path(__file__).resolve().parent.parent / "firmware"

# Expected naming convention for uploaded/committed packages, e.g. "IMU_Capture-1.2.0.zip".
_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")

# USB vendor ID shared by every Seeed XIAO nRF52840 variant (plain/Sense/Plus/Sense Plus).
SEEED_XIAO_VID = 0x2886

TOUCH_BAUD = 1200
DFU_BAUD = 115200
PORT_REAPPEAR_TIMEOUT_S = 15.0
NRFUTIL_TIMEOUT_S = 180.0

ProgressCb = Callable[[str, str, "int | None"], Awaitable[None]]


class FlashError(Exception):
    """Raised for any expected failure of the USB flashing flow (bad file, no port, tool missing)."""


def _serial_modules():
    """Import pyserial only for a USB operation, so the dashboard can still start without it."""
    try:
        import serial
        from serial.tools import list_ports
    except ModuleNotFoundError as exc:
        raise FlashError("pyserial est introuvable. Installez les dépendances de l'application.") from exc
    return serial, list_ports


def ensure_firmware_dir() -> None:
    FIRMWARE_DIR.mkdir(parents=True, exist_ok=True)


def list_firmware() -> list[dict]:
    ensure_firmware_dir()
    entries = []
    for path in sorted(FIRMWARE_DIR.glob("*.zip")):
        stat = path.stat()
        version = parse_version(path.name)
        entries.append({
            "filename": path.name,
            "size": stat.st_size,
            "uploaded_at": stat.st_mtime,
            "version": version_to_str(version) if version else None,
        })
    return entries


def parse_version(filename: str) -> tuple[int, int, int] | None:
    """Extracts a MAJOR.MINOR.PATCH version from a firmware filename, e.g.
    'IMU_Capture-1.2.0.zip' -> (1, 2, 0). Returns None if no version is found.
    """
    match = _VERSION_RE.search(filename)
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def version_to_str(version: tuple[int, int, int]) -> str:
    return ".".join(str(part) for part in version)


def latest_firmware() -> dict | None:
    """Returns the {filename, version} of the highest-versioned package available, or None."""
    best: tuple[tuple[int, int, int], str] | None = None
    for path in FIRMWARE_DIR.glob("*.zip") if FIRMWARE_DIR.is_dir() else []:
        version = parse_version(path.name)
        if version is None:
            continue
        if best is None or version > best[0]:
            best = (version, path.name)
    if best is None:
        return None
    return {"filename": best[1], "version": version_to_str(best[0])}


def is_newer(current_version: str | None, candidate_version: str | None) -> bool:
    """True if `candidate_version` (e.g. from the firmware folder) is newer than
    `current_version` (e.g. reported live by a satellite). Malformed/missing -> False.
    """
    current = parse_version(current_version or "")
    candidate = parse_version(candidate_version or "")
    if current is None or candidate is None:
        return False
    return candidate > current


def save_firmware(filename: str, data: bytes) -> str:
    ensure_firmware_dir()
    safe_name = Path(filename).name  # strip any directory components from the upload
    if not safe_name.lower().endswith(".zip"):
        raise FlashError("Le firmware doit être un paquet .zip (DFU), généré par la compilation Arduino")
    if not data:
        raise FlashError("Fichier vide")
    (FIRMWARE_DIR / safe_name).write_bytes(data)
    return safe_name


def delete_firmware(filename: str) -> bool:
    dest = FIRMWARE_DIR / Path(filename).name
    if not dest.is_file():
        return False
    dest.unlink()
    return True


def list_serial_ports() -> list[dict]:
    _, list_ports = _serial_modules()
    return [
        {
            "device": p.device,
            "description": p.description or "",
            "vid": p.vid,
            "pid": p.pid,
            "likely_satellite": p.vid == SEEED_XIAO_VID,
        }
        for p in list_ports.comports()
    ]


def _touch_1200bps(port: str) -> None:
    """Classic bootloader-entry trick: briefly open the port at 1200 baud then close it."""
    serial, _ = _serial_modules()
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = TOUCH_BAUD
    ser.dtr = False
    ser.open()
    ser.close()


def _seeed_ports() -> set[str]:
    _, list_ports = _serial_modules()
    return {p.device for p in list_ports.comports() if p.vid == SEEED_XIAO_VID}


def _wait_for_bootloader_port(known_ports: set[str], original_port: str, timeout_s: float) -> str:
    """After the touch, the board reboots into the bootloader and re-enumerates over USB: wait
    for a new Seeed XIAO port to show up. Some OSes reuse `original_port`; track its temporary
    disappearance so a batch never mistakes another board's already-prepared bootloader for it.
    """
    deadline = time.monotonic() + timeout_s
    last_seen: set[str] = set()
    original_disappeared = False
    while time.monotonic() < deadline:
        current = _seeed_ports()
        if original_port not in current:
            original_disappeared = True
        elif original_disappeared:
            return original_port
        new_ports = current - known_ports
        if new_ports:
            return sorted(new_ports)[0]
        last_seen = current
        time.sleep(0.3)
    if original_port in last_seen:
        return original_port
    raise FlashError("Le satellite n'est pas réapparu après le redémarrage en mode bootloader")


def _resolve_nrfutil_cmd() -> list[str] | None:
    scripts_dir = Path(sys.executable).parent
    for name in ("adafruit-nrfutil", "adafruit-nrfutil.exe"):
        executable = scripts_dir / name
        if executable.is_file():
            return [str(executable)]
    exe = shutil.which("adafruit-nrfutil")
    return [exe] if exe else None


async def prepare_flash(port: str, progress_cb: ProgressCb) -> str:
    """Restart one satellite into its bootloader and return its serial port.

    Callers must prepare satellites one at a time: while boards re-enumerate, a concurrent
    port scan cannot reliably associate a newly appeared bootloader with its original port.
    """
    loop = asyncio.get_running_loop()

    await progress_cb("touch", f"Redémarrage de {port} en mode bootloader...", 5)
    known_ports = _seeed_ports()
    try:
        await loop.run_in_executor(None, _touch_1200bps, port)
    except FlashError:
        raise
    except Exception as exc:
        raise FlashError(f"Impossible d'ouvrir le port {port} : {exc}") from exc

    await progress_cb("waiting", "Attente de la réapparition du satellite...", 15)
    return await loop.run_in_executor(
        None, _wait_for_bootloader_port, known_ports, port, PORT_REAPPEAR_TIMEOUT_S
    )


async def transfer_firmware(bootloader_port: str, zip_path: Path, progress_cb: ProgressCb) -> None:
    """Transfer a DFU package to a satellite already running its bootloader."""
    nrfutil_cmd = _resolve_nrfutil_cmd()
    if nrfutil_cmd is None:
        raise FlashError("adafruit-nrfutil est introuvable. Installez-le avec : pip install adafruit-nrfutil")
    if not zip_path.is_file():
        raise FlashError(f"Firmware introuvable : {zip_path.name}")

    await progress_cb("flashing", f"Transfert du firmware vers {bootloader_port}...", 25)
    cmd = [
        *nrfutil_cmd, "dfu", "serial",
        "-pkg", str(zip_path),
        "-p", bootloader_port,
        "-b", str(DFU_BAUD),
        "--singlebank",
    ]
    log.info("Running: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )

    percent = 25
    assert proc.stdout is not None
    try:
        async for raw_line in proc.stdout:
            line = raw_line.decode(errors="replace").strip()
            if not line:
                continue
            log.info("nrfutil: %s", line)
            percent = min(95, percent + 2)
            await progress_cb("flashing", line, percent)
        returncode = await asyncio.wait_for(proc.wait(), timeout=NRFUTIL_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        raise FlashError("La mise à jour a dépassé le délai imparti")

    if returncode != 0:
        raise FlashError(f"adafruit-nrfutil a échoué (code {returncode})")

    await progress_cb("done", "Mise à jour terminée avec succès", 100)


async def flash_firmware(port: str, zip_path: Path, progress_cb: ProgressCb) -> None:
    """Flash `zip_path` (a DFU package) onto one satellite connected over USB."""
    bootloader_port = await prepare_flash(port, progress_cb)
    await transfer_firmware(bootloader_port, zip_path, progress_cb)
