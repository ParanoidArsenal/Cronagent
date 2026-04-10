# Deployment Guide

## Quick Start (no CI/CD)

```bash
git clone <repo> /opt/cronagent
cd /opt/cronagent
cp .env.example .env
# Copy your ~/.claude credentials to the server
docker compose up -d
```

## Host Requirements

- **Linux server** with Docker + Docker Compose installed
- **Claude API credentials** at `~/.claude` on the host (the app runs Claude for automations)
- **Docker socket access** — the app spawns sandbox containers, so the user running it needs to be in the `docker` group
- **Port 3000** open (web UI); optionally 5432 for external DB access
- **Disk space** — a few GB for PostgreSQL data volume + Docker images

## Environment Variables

### Required

`DATABASE_URL` is the only truly required variable, but it's already hardcoded in `docker-compose.yml` as `postgresql://automation:automation@db:5432/cronagent` — so **you get it for free** from the `db` service.

You can deploy with an empty `.env` file (or just copy `.env.example` as-is).

### Defaults (set in Dockerfile / docker-compose.yml)

| Variable          | Default                      | Where set        |
|-------------------|------------------------------|------------------|
| `AUTOMATIONS_DIR` | `/app/automations`           | Dockerfile       |
| `MCP_CONFIG`      | `/app/mcp.json`              | Dockerfile       |
| `SANDBOX_IMAGE`   | `cronagent-sandbox`    | docker-compose   |
| `PORT`            | `3000`                       | Dockerfile       |
| `HOSTNAME`        | `0.0.0.0`                    | Dockerfile       |
| `LOG_LEVEL`       | `info`                       | Optional         |

### Optional Integrations

Only needed if you use the corresponding MCP servers:

| Variable             | Purpose                          |
|----------------------|----------------------------------|
| `WEBHOOK_URL`        | Slack/Mattermost notifications   |
| `JIRA_URL`           | JIRA MCP server                  |
| `JIRA_TOKEN`         | JIRA authentication              |
| `GITLAB_URL`         | GitLab MCP server                |
| `GITLAB_TOKEN`       | GitLab authentication            |
| `MATTERMOST_URL`     | Mattermost MCP server            |
| `MATTERMOST_TOKEN`   | Mattermost authentication        |

## CI/CD Pipeline (Jenkins)

The project includes a `Jenkinsfile` for automated deployment:

1. **Build & Push** — runs `build.sh` (docker compose build + push)
2. **Deploy** — SSHs to target, pulls latest images, runs `docker compose up -d`
3. **Notifications** — updates GitLab commit status on success/failure

### Jenkins Requirements

- Jenkins instance with GitLab plugin
- Build agent labeled `build-agent`
- Docker registry to push images to (configure `image:` in docker-compose.yml)
- SSH access from Jenkins to the deploy host
- Repo cloned at `/opt/cronagent` on target with a valid `.env`

## Architecture

Single-machine Docker Compose setup with 4 services:

- **db** — PostgreSQL 16 with persistent volume
- **web** — Next.js app on port 3000 (web UI + API)
- **daemon** — cron daemon for scheduled automations
- **sandbox-image** — one-shot service that builds the sandbox Docker image

All services have `restart: unless-stopped` for auto-recovery.
