FROM node:24-slim

RUN apt-get update && apt-get install -y \
    bash \
    curl \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

# Non-root user for safety
RUN useradd -m -s /bin/bash sandbox \
    && mkdir -p /home/sandbox/.claude \
    && chown -R sandbox:sandbox /home/sandbox/.claude

USER sandbox

ENTRYPOINT ["bash", "-c"]
