#!/usr/bin/env bash
# Wrapper script for running MCP servers with env vars from .env.mcp
# Usage: scripts/run-mcp.sh <server-name>
# Example: scripts/run-mcp.sh jira

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SERVER_NAME="${1:?Usage: run-mcp.sh <server-name>}"
SERVER_DIR="$PROJECT_ROOT/mcp-servers/$SERVER_NAME"

if [ ! -d "$SERVER_DIR" ]; then
  echo "MCP server '$SERVER_NAME' not found in $SERVER_DIR" >&2
  exit 1
fi

# Load env vars from .env.mcp if it exists
ENV_FILE="$PROJECT_ROOT/.env.mcp"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Auto-build if dist/ doesn't exist
if [ ! -d "$SERVER_DIR/dist" ]; then
  echo "Building $SERVER_NAME MCP server..." >&2
  (cd "$SERVER_DIR" && npm install --silent && npm run build) >&2
fi

exec node "$SERVER_DIR/dist/index.js"
