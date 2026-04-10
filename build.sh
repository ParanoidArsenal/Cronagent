#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

echo "=================================================="
echo "Building cronagent containers"
echo "=================================================="

docker compose build

echo ""
echo "=================================================="
echo "Pushing images..."
echo "=================================================="

docker compose push

echo ""
echo "=================================================="
echo "Done!"
echo "=================================================="
