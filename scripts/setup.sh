#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== SHB — Brain Setup ==="
echo ""

# 1. Check prerequisites
echo "Checking prerequisites..."

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker is required. Install Docker Desktop first."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: node is required (v18+)."
  exit 1
fi

echo "  docker: $(docker --version | head -1)"
echo "  node:   $(node --version)"
echo ""

# 2. Create .env if missing
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "Creating .env from .env.example..."
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo "  Edit .env to customize settings if needed."
else
  echo ".env already exists, skipping."
fi
echo ""

# 3. Start PostgreSQL
echo "Starting PostgreSQL with pgvector..."
cd "$PROJECT_DIR"
docker compose up -d
echo "  Waiting for database to be healthy..."
until docker compose exec postgres pg_isready -U shb -d shb &>/dev/null; do
  sleep 1
done
echo "  Database is ready."
echo ""

# 4. Install CLI dependencies and build
echo "Installing CLI dependencies..."
cd "$PROJECT_DIR/cli"
npm install
echo ""

echo "Building CLI..."
npm run build
echo ""

# 5. Link CLI globally
echo "Linking shb command globally..."
npm link
echo ""

# 6. Verify
echo "Running health check..."
shb health
echo ""

echo "=== SHB Setup Complete ==="
echo ""
echo "Usage:"
echo "  shb remember --type user --title 'My Role' --content 'I am a DB engineer'"
echo "  shb recall 'what does the user do'"
echo "  shb reflect stats"
echo "  shb gateway start"
echo "  shb health"
echo ""
