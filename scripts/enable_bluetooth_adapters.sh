#!/usr/bin/env bash
# Unblock and enable every Bluetooth controller currently detected by BlueZ.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root." >&2
  exit 1
fi

rfkill unblock bluetooth || true

shopt -s nullglob
for controller_path in /sys/class/bluetooth/hci*; do
  controller="${controller_path##*/}"
  echo "==> Enabling Bluetooth controller ${controller}..."
  hciconfig "$controller" up || true
done