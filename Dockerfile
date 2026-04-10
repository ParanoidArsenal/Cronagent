# ── Dev image (used by web-dev service) ──────────────────
FROM node:24-slim AS dev

RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gosu \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (needed for sandbox-mode automations)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.3.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Install Claude CLI (needed for claude-mode automations)
RUN npm install -g @anthropic-ai/claude-code

# Rename node (UID 1000) → claude — matches typical host UID for bind mounts
RUN usermod -l claude -d /home/claude -m node \
    && groupmod -n claude node \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude/.claude

ENV HOME=/home/claude
WORKDIR /app/web

# ── Build stage ──────────────────────────────────────────
FROM node:24-slim AS base

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root dependencies
COPY package.json package-lock.json ./
RUN npm install

# Install web dependencies
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm install

# Install MCP server dependencies
COPY mcp-servers/ ./mcp-servers/
RUN for dir in mcp-servers/*/; do \
      if [ -f "$dir/package.json" ]; then \
        cd /app/$dir && npm install --omit=dev; \
        cd /app; \
      fi; \
    done

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./
COPY automations/ ./automations/
COPY mcp.json ./
COPY web/ ./web/

# Build web
RUN cd web && npx next build

# ── Production image ─────────────────────────────────────
FROM node:24-slim AS runner

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    wget \
    curl \
    gosu \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (needed for sandbox-mode automations via mounted docker.sock)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.3.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Install Claude CLI (needed for claude-mode automations)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Create non-root user for running Claude CLI
RUN useradd -m -s /bin/bash claude \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude/.claude

ENV NODE_ENV=production

# Copy root deps and source (needed at runtime for server external packages)
COPY --from=base /app/package.json /app/package-lock.json ./
COPY --from=base /app/node_modules/ ./node_modules/
COPY --from=base /app/src/ ./src/
COPY --from=base /app/tsconfig.json ./
COPY --from=base /app/mcp.json ./
COPY --from=base /app/mcp-servers/ ./mcp-servers/

# Copy Next.js standalone output
COPY --from=base /app/web/.next/standalone/web/ ./web/
COPY --from=base /app/web/.next/static ./web/.next/static
COPY --from=base /app/web/node_modules/ ./web/node_modules/

# Default automations (can be overridden via volume mount)
COPY --from=base /app/automations/ ./automations/

# Writable dirs for non-root user
RUN mkdir -p /app/logs && chown -R claude:claude /app/logs

ENV AUTOMATIONS_DIR=/app/automations
ENV MCP_CONFIG=/app/mcp.json
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HOME=/home/claude

EXPOSE 3000

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/stats || exit 1

CMD ["node", "web/server.js"]
