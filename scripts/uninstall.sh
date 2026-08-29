#!/usr/bin/env bash
# Reverses install.sh: stops/removes the systemd service, WiFi AP connections, and the venv.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="ble-central"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo ./scripts/uninstall.sh)." >&2
  exit 1
fi

echo "==> Stopping and disabling systemd service..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  if [ -f "$SERVICE_FILE" ]; then
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
  fi
else
  echo "systemctl not found, skipping (e.g. running under WSL)."
fi

if command -v nmcli >/dev/null 2>&1; then
  echo "==> Removing WiFi access point connection..."
  nmcli connection delete "ble-imu-hotspot" >/dev/null 2>&1 || true
  echo "==> Removing wired connection profile..."
  nmcli connection delete "ble-wired" >/dev/null 2>&1 || true
fi

echo "==> Removing SQLite database..."
rm -f "$APP_DIR/data.db"

echo "==> Removing Python virtual environment..."
rm -rf "$APP_DIR/.venv"

echo "==> Done. App files in $APP_DIR were left in place."
