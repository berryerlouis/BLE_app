"""Build and publish a versioned DFU archive before each satellite firmware commit."""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
APP_FIRMWARE_DIR = ROOT.parent / "BLE_app" / "firmware"
VERSION_FILE = ROOT / "VERSION"
VERSION_HEADER = ROOT / "Version.h"
BUILD_DIR = ROOT / "build" / "cli"
DFU_ARCHIVE = BUILD_DIR / "IMU_Capture.ino.zip"
FQBN = "Seeeduino:mbed:xiaonRF52840Sense"
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def next_patch_version(version: str) -> str:
    match = VERSION_RE.fullmatch(version.strip())
    if match is None:
        raise ValueError(f"VERSION doit respecter MAJOR.MINOR.PATCH, reçu : {version!r}")
    major, minor, patch = (int(part) for part in match.groups())
    return f"{major}.{minor}.{patch + 1}"


def find_arduino_cli() -> str:
    configured = os.environ.get("ARDUINO_CLI")
    if configured:
        return configured

    from_path = shutil.which("arduino-cli")
    if from_path:
        return from_path

    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        bundled = Path(local_app_data) / "Programs" / "Arduino IDE" / "resources" / "app" / "lib" / "backend" / "resources" / "arduino-cli.exe"
        if bundled.is_file():
            return str(bundled)

    raise FileNotFoundError("arduino-cli introuvable. Définissez ARDUINO_CLI ou installez Arduino IDE.")


def write_version(version: str) -> None:
    VERSION_FILE.write_text(f"{version}\n", encoding="ascii")
    header = VERSION_HEADER.read_text(encoding="ascii")
    updated_header, replacements = re.subn(
        r'(#define\s+FIRMWARE_VERSION\s+")[^"]+(".*)',
        rf"\g<1>{version}\g<2>",
        header,
    )
    if replacements != 1:
        raise ValueError("Version.h doit contenir exactement un #define FIRMWARE_VERSION")
    VERSION_HEADER.write_text(updated_header, encoding="ascii")


def run_release(version: str) -> Path:
    write_version(version)
    subprocess.run(
        [
            find_arduino_cli(),
            "compile",
            "--fqbn",
            FQBN,
            "--build-path",
            str(BUILD_DIR),
            str(ROOT),
        ],
        check=True,
        cwd=ROOT,
    )
    if not DFU_ARCHIVE.is_file():
        raise FileNotFoundError(f"Archive DFU introuvable après compilation : {DFU_ARCHIVE}")

    APP_FIRMWARE_DIR.mkdir(parents=True, exist_ok=True)
    destination = APP_FIRMWARE_DIR / f"IMU_Capture-{version}.zip"
    shutil.copy2(DFU_ARCHIVE, destination)
    subprocess.run(["git", "add", "VERSION", "Version.h"], check=True, cwd=ROOT)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Afficher la prochaine version sans écrire ni compiler")
    args = parser.parse_args()

    next_version = next_patch_version(VERSION_FILE.read_text(encoding="ascii"))
    if args.dry_run:
        print(f"Prochaine version : {next_version}")
        print(f"Destination : {APP_FIRMWARE_DIR / f'IMU_Capture-{next_version}.zip'}")
        print(f"Arduino CLI : {find_arduino_cli()}")
        return 0

    destination = run_release(next_version)
    print(f"Firmware {next_version} généré : {destination}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, subprocess.CalledProcessError, ValueError) as exc:
        print(f"Échec de la publication du firmware : {exc}", file=sys.stderr)
        raise SystemExit(1)