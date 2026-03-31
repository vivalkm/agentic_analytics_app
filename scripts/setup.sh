#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Lakehouse Analytics Setup ==="
echo ""

# 1. Node dependencies
echo "[1/3] Installing Node dependencies..."
if command -v npm &>/dev/null; then
  npm install
else
  echo "Error: npm not found. Install Node.js first: https://nodejs.org"
  exit 1
fi

# 2. Python venv + trino package
echo ""
echo "[2/3] Setting up Python virtual environment..."
if command -v uv &>/dev/null; then
  uv venv .venv
  uv pip install trino --python .venv/bin/python
elif command -v python3 &>/dev/null; then
  python3 -m venv .venv
  .venv/bin/pip install trino
else
  echo "Error: python3 not found. Install Python 3.10+ first."
  exit 1
fi

# 3. Environment file
echo ""
echo "[3/3] Setting up environment..."
if [ ! -f .env.local ]; then
  cp .env.local.example .env.local
  echo "Created .env.local from template. Edit it to add your ANTHROPIC_API_KEY."
else
  echo ".env.local already exists — skipping."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env.local and set ANTHROPIC_API_KEY"
echo "  2. Run: npm run dev"
echo "  3. Open: http://localhost:3000"
