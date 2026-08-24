#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
cd "$PROJECT_DIR"

if [[ ! -x .venv/bin/python ]]; then
  uv venv --python 3.12 .venv
fi
uv pip install -p .venv -e ".[dev]"

# pnpm is the fastest option, but it is not installed on every Mac. Keep the
# setup self-contained by falling back to npm, which ships with Node.js.
if command -v pnpm >/dev/null 2>&1; then
  pnpm --dir frontend install
  pnpm --dir frontend build
elif command -v npm >/dev/null 2>&1; then
  npm --prefix frontend install --no-package-lock --no-audit --no-fund
  npm --prefix frontend run build
else
  echo "ARC needs Node.js to build the frontend. Install Node.js, then run ./scripts/setup.sh again." >&2
  exit 1
fi

echo "ARC is ready. Run ./scripts/start.sh"
