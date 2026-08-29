"""Self-update helpers: compares the local git checkout against the GitHub repo
(berryerlouis/BLE_app) and can pull + restart the app when a newer version is available.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

log = logging.getLogger("update")

REPO_DIR = Path(__file__).resolve().parent.parent
VERSION_FILE = REPO_DIR / "VERSION"
GIT_BRANCH = "main"
AUTHOR = "Louis Berryer"


def read_local_version() -> str:
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return "0.0.0"


async def _run(*args: str) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=REPO_DIR, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode().strip(), stderr.decode().strip()


async def get_local_commit() -> str | None:
    code, out, _ = await _run("git", "rev-parse", "HEAD")
    return out if code == 0 else None


async def check_update() -> dict:
    """Fetch the remote branch and report whether a newer commit/version is available."""
    fetch_code, _, fetch_err = await _run("git", "fetch", "origin", GIT_BRANCH)
    if fetch_code != 0:
        log.warning("git fetch failed: %s", fetch_err)
        return {
            "current_version": read_local_version(),
            "latest_version": None,
            "update_available": False,
            "error": "git fetch failed (offline?)",
        }

    local_commit = await get_local_commit()
    remote_code, remote_commit, _ = await _run("git", "rev-parse", f"origin/{GIT_BRANCH}")
    version_code, remote_version, _ = await _run("git", "show", f"origin/{GIT_BRANCH}:VERSION")

    remote_commit = remote_commit if remote_code == 0 else None
    remote_version = remote_version.strip() if version_code == 0 else None

    return {
        "current_version": read_local_version(),
        "latest_version": remote_version,
        "current_commit": local_commit,
        "latest_commit": remote_commit,
        "update_available": bool(local_commit and remote_commit and local_commit != remote_commit),
    }


async def apply_update() -> dict:
    """Reset the working tree to origin/main, reinstall deps, then exit so systemd restarts us."""
    fetch_code, _, fetch_err = await _run("git", "fetch", "origin", GIT_BRANCH)
    if fetch_code != 0:
        raise RuntimeError(f"git fetch failed: {fetch_err}")

    # git reset --hard only touches tracked files; secrets.yaml (git-ignored) is left untouched.
    reset_code, _, reset_err = await _run("git", "reset", "--hard", f"origin/{GIT_BRANCH}")
    if reset_code != 0:
        raise RuntimeError(f"git reset failed: {reset_err}")

    venv_pip = REPO_DIR / ".venv" / "bin" / "pip"
    if venv_pip.exists():
        pip_code, _, pip_err = await _run(str(venv_pip), "install", "-r", "requirements.txt")
        if pip_code != 0:
            log.warning("pip install failed during update: %s", pip_err)

    new_version = read_local_version()
    log.info("Update applied, now at version %s. Restarting process...", new_version)

    # Restart=always in the systemd unit relaunches the process automatically on clean exit.
    asyncio.get_event_loop().call_later(1.0, os._exit, 0)
    return {"restarting": True, "new_version": new_version}
