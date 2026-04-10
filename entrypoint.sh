#!/bin/sh
set -e

# ── Docker socket access ─────────────────────────────────
# Detect the Docker socket GID at runtime and add the claude user to that group.
# This makes the entrypoint portable across hosts with different docker GIDs.
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
    groupadd -g "$DOCKER_GID" docker-host
  fi
  usermod -aG "$DOCKER_GID" claude 2>/dev/null || true
fi

# ── Match workspace UID ───────────────────────────────────
# Non-sandbox automations run on the host workspace.  Match the claude
# user's UID/GID to the workspace owner so file access just works.
if [ -n "$WORKSPACE_DIR" ] && [ -d "$WORKSPACE_DIR" ]; then
  WS_UID=$(stat -c '%u' "$WORKSPACE_DIR")
  WS_GID=$(stat -c '%g' "$WORKSPACE_DIR")
  CUR_UID=$(id -u claude)
  if [ "$WS_UID" != "$CUR_UID" ] && [ "$WS_UID" != "0" ]; then
    usermod -u "$WS_UID" claude 2>/dev/null || true
    groupmod -g "$WS_GID" claude 2>/dev/null || true
  fi
fi

# ── Fix volume ownership ─────────────────────────────────
# Mounted volumes may have stale UIDs from a previous build.
chown -R claude:claude /home/claude 2>/dev/null || true
chown -R claude:claude /app/logs 2>/dev/null || true
chown -R claude:claude /app/automations 2>/dev/null || true
# Next.js dev cache may have stale ownership from prior builds
[ -d /app/web/.next ] && chown -R claude:claude /app/web/.next 2>/dev/null || true

# ── Git safe directory ───────────────────────────────────
# Mounted workspaces are owned by the host UID, which may differ from the
# container user.  Allow git to operate on any directory.
gosu claude git config --global --add safe.directory '*' 2>/dev/null || true

# ── Drop to claude user ──────────────────────────────────
exec gosu claude "$@"
