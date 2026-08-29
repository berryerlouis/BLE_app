#!/usr/bin/env bash
# One-shot installer for the Raspberry Pi: system deps, venv, Wi-Fi AP, systemd service.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="ble-central"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo ./scripts/install.sh)." >&2
  exit 1
fi

echo "==> Installing system packages..."
apt-get update
apt-get install -y python3-venv python3-pip bluetooth bluez network-manager

echo "==> Creating Python virtual environment..."
sudo -u "${SUDO_USER:-pi}" python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

if [ ! -f "$APP_DIR/secrets.yaml" ]; then
  echo "==> No secrets.yaml found, creating one from secrets.example.yaml (edit the Wi-Fi password!)..."
  sudo -u "${SUDO_USER:-pi}" cp "$APP_DIR/secrets.example.yaml" "$APP_DIR/secrets.yaml"
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
