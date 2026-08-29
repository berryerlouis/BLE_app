#!/usr/bin/env bash
# One-shot installer: system deps, venv, and (on real hardware only) Wi-Fi AP + systemd service.
# Under WSL there is no Wi-Fi hardware and usually no systemd, so those steps are skipped;
# use the "Run BLE_app" VS Code task (see .vscode/tasks.json) to start the app instead.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="ble-central"

IS_WSL=false
if grep -qi microsoft /proc/version 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}" ]; then
  IS_WSL=true
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo ./scripts/install.sh)." >&2
  exit 1
fi

echo "==> Installing system packages..."
apt-get update
if [ "$IS_WSL" = true ]; then
  apt-get install -y python3-venv python3-pip bluetooth bluez
else
  apt-get install -y python3-venv python3-pip bluetooth bluez network-manager
fi

echo "==> Creating Python virtual environment..."
sudo -u "${SUDO_USER:-pi}" python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

if [ ! -f "$APP_DIR/data.db" ]; then
  echo "==> Initializing SQLite database..."
  touch "$APP_DIR/data.db"
  chown "${SUDO_USER:-pi}:${SUDO_USER:-pi}" "$APP_DIR/data.db"
fi

if [ ! -f "$APP_DIR/secrets.yaml" ]; then
  echo "==> No secrets.yaml found, creating one from secrets.example.yaml (edit the Wi-Fi password!)..."
  sudo -u "${SUDO_USER:-pi}" cp "$APP_DIR/secrets.example.yaml" "$APP_DIR/secrets.yaml"
fi

if [ "$IS_WSL" = true ]; then
  echo "==> WSL detected: skipping Wi-Fi access point setup and systemd service installation."
  echo "==> Done. Run the app with: sudo $APP_DIR/.venv/bin/python $APP_DIR/main.py"
  echo "    (or use the 'Run BLE_app' task in VS Code)"
  exit 0
fi

echo "==> Configuring Wi-Fi access point..."
"$APP_DIR/scripts/setup_ap.sh"

echo "==> Installing systemd service..."
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
sed \
  -e "s#/home/pi/BLE_app#${APP_DIR}#g" \
  -e "s#User=pi#User=${SUDO_USER:-pi}#g" \
  "$APP_DIR/scripts/ble-central.service" > "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "==> Done. Check status with: systemctl status ${SERVICE_NAME}"
