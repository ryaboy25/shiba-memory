#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Claude Code Brain (CCB) Setup ==="
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
until docker compose exec postgres pg_isready -U ccb -d ccb &>/dev/null; do
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
echo "Linking ccb command globally..."
npm link
echo ""

# 6. Verify
echo "Running health check..."
ccb health
echo ""

echo "=== CCB Setup Complete ==="
echo ""
echo "Usage:"
echo "  ccb remember --type user --title 'My Role' --content 'I am a DB engineer'"
echo "  ccb recall 'what does the user do'"
echo "  ccb reflect stats"
echo "  ccb health"
echo ""
echo "To install Claude Code skills, copy the skills/*.md files to your"
echo "Claude Code skills directory (e.g. ~/.claude/skills/)."
