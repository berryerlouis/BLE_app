#!/usr/bin/env bash
# Runs scripts/seed_sample_data.py using the project's Linux venv (WSL/Raspberry Pi).
# Usage: ./scripts/seed_sample_data.sh [--reset]
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$APP_DIR/.venv/bin/python"

if [ ! -x "$PYTHON" ]; then
  echo "==> No .venv found, using system python3 instead." >&2
  PYTHON="python3"
fi

"$PYTHON" "$APP_DIR/scripts/seed_sample_data.py" "$@"
