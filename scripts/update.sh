#!/usr/bin/env bash
# Pulls the latest code from berryerlouis/BLE_app (main branch) and restarts the app.
# Can be run manually, from a cron job, or is triggered by the "Update" button in the dashboard
# (via POST /api/update/apply, which does the same git reset + pip install + restart).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="main"
SERVICE_NAME="ble-central"

cd "$APP_DIR"

echo "==> Fetching latest changes from origin/$BRANCH..."
git fetch origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" == "$REMOTE" ]; then
  echo "Already up to date ($LOCAL)."
  exit 0
fi

echo "==> Updating from $LOCAL to $REMOTE..."
# --hard only discards changes to tracked files; secrets.yaml (git-ignored) is preserved.
git reset --hard "origin/$BRANCH"

if [ -x "$APP_DIR/.venv/bin/pip" ]; then
  echo "==> Reinstalling Python dependencies..."
  "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"
fi

echo "==> Restarting $SERVICE_NAME..."
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  sudo systemctl restart "$SERVICE_NAME"
else
  echo "systemd service not found, please restart the app manually (python main.py)."
fi

echo "==> Update complete, now at version $(cat VERSION 2>/dev/null || echo unknown)."
