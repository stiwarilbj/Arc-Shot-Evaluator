#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
cd "$PROJECT_DIR"

if [[ ! -x .venv/bin/python || ! -f frontend/dist/index.html ]]; then
  echo "ARC is not set up yet. Run ./scripts/setup.sh first."
  exit 1
fi

exec .venv/bin/python -m backend
