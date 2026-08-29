#!/usr/bin/env bash
# Creates (or updates) a NetworkManager WiFi hotspot connection that autoconnects at boot,
# without disturbing any existing wired (Ethernet) connection.
# Works on Raspberry Pi OS Bookworm+ (NetworkManager is the default network backend).
set -euo pipefail

CONFIG_FILE="$(dirname "$0")/../config.yaml"
SECRETS_FILE="$(dirname "$0")/../secrets.yaml"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Missing $SECRETS_FILE. Copy secrets.example.yaml to secrets.yaml and set wifi_ap.password." >&2
  exit 1
fi

read_yaml() {
  python3 - "$1" "$2" <<'PY'
import sys, yaml
with open(sys.argv[1]) as f:
    cfg = yaml.safe_load(f)
print(cfg["wifi_ap"][sys.argv[2]])
PY
}

SSID="$(read_yaml "$CONFIG_FILE" ssid)"
PASSWORD="$(read_yaml "$SECRETS_FILE" password)"
IFACE="$(read_yaml "$CONFIG_FILE" interface)"
CON_NAME="ble-imu-hotspot"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "nmcli not found. This script requires NetworkManager." >&2
  exit 1
fi

# Make sure the Ethernet interface keeps its own autoconnecting profile so it is never
# affected by the WiFi hotspot below (both interfaces are independent, but NetworkManager
# only guarantees Ethernet comes back up automatically if a connection profile exists for it).
ETH_IFACE="$(nmcli -t -f DEVICE,TYPE device status | awk -F: '$2=="ethernet"{print $1; exit}')"
if [ -n "$ETH_IFACE" ]; then
  if ! nmcli -t -f DEVICE connection show --active | grep -qx "$ETH_IFACE"; then
    echo "No active wired connection found on $ETH_IFACE, creating one..."
  fi
  if ! nmcli -t -f NAME connection show | grep -qx "ble-wired"; then
    nmcli connection add type ethernet ifname "$ETH_IFACE" con-name "ble-wired" autoconnect yes
  fi
  nmcli connection modify "ble-wired" connection.autoconnect-priority 200 ipv4.never-default no
  nmcli connection up "ble-wired" >/dev/null 2>&1 || true
else
  echo "Warning: no Ethernet interface detected, skipping wired profile setup." >&2
fi

echo "Configuring WiFi access point '$SSID' on $IFACE..."

nmcli connection delete "$CON_NAME" >/dev/null 2>&1 || true

nmcli connection add \
  type wifi \
  ifname "$IFACE" \
  con-name "$CON_NAME" \
  autoconnect yes \
  ssid "$SSID"

nmcli connection modify "$CON_NAME" \
  802-11-wireless.mode ap \
  802-11-wireless.band bg \
  ipv4.method shared \
  ipv6.method disabled \
  wifi-sec.key-mgmt wpa-psk \
  wifi-sec.psk "$PASSWORD" \
  connection.autoconnect-priority 100 \
  ipv4.never-default yes

nmcli connection up "$CON_NAME"

echo "Access point '$SSID' is up on $IFACE. Connected clients will get an IP via NAT (10.42.x.x)."
echo "Ethernet stays the default route (ipv4.never-default yes on the hotspot), so SSH over eth0 is preserved."
echo "Dashboard will be reachable at http://<pi-ip>:8080 once the ble-central service starts."

