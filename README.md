# cronagent

Personal automation hub — define, run, compose, and schedule all your micro-automations from a single web UI or CLI. Like Jupyter notebooks but for your daily workflow.

## Prerequisites

- **Node.js** >= 20.0.0
- **Docker** and **Docker Compose** (for PostgreSQL, sandboxing, and production deployment)
- **Claude CLI** installed and authenticated (`claude --version` should work)
- **MCP credentials** (optional) — GitLab token, Jira token, Mattermost token for corresponding integrations

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url>
cd cronagent
cp .env.example .env
```

Edit `.env` and fill in the required values:

```bash
# Required
DATABASE_URL=postgresql://automation:automation@db:5432/cronagent

# Optional — MCP integrations
GITLAB_URL=https://gitlab.example.com
GITLAB_TOKEN=glpat-...
JIRA_URL=https://jira.example.com
JIRA_TOKEN=...
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_TOKEN=...

# Optional — notifications
WEBHOOK_URL=https://hooks.slack.com/services/...
TELEGRAM_BOT_TOKEN=123456:ABC-...
TELEGRAM_CHAT_ID=-100...
MATTERMOST_WEBHOOK_URL=https://mattermost.example.com/hooks/...
```

### 2. Run with Docker (recommended)

#### Production mode

```bash
docker compose --profile prod up --build
```

This starts 4 services:
- **db** — PostgreSQL 16 (data persisted in `pgdata` volume)
- **web** — Next.js web UI + API on port 3000
- **daemon** — cron scheduler running in background
- **sandbox-image** — one-shot build of the sandbox Docker image

Web UI at `http://localhost:3000`.

#### Development mode (hot reload)

```bash
docker compose --profile dev up
```

Mounts source directly into the container. Next.js dev server auto-reloads on file changes — no image rebuild needed. Only starts `db` and `web-dev` (no daemon).

### 3. Run locally (no Docker for the app)

```bash
# Install dependencies
npm install
cd web && npm install && cd ..

# Start Postgres (still uses Docker)
docker compose up db

# Terminal 1 — Web UI + API (hot reload)
npm run web

# Terminal 2 — Cron daemon (optional, for scheduled automations)
npm run daemon
```

Web UI at `http://localhost:3000`.

### 4. CLI-only mode

You can run automations without the web UI:

```bash
npm run repl                          # interactive REPL
npx tsx src/index.ts run check-mrs    # run a single automation
npx tsx src/index.ts daemon           # start cron scheduler
npx tsx src/index.ts list             # list all automations
npx tsx src/index.ts history          # show execution history
npx tsx src/index.ts seed             # populate demo automations
```

### REPL commands

The interactive REPL (`npm run repl`) supports:

| Command | Description |
|---|---|
| `run <name>` | Execute an automation |
| `list` | List all automations |
| `history [name]` | Show execution history |
| `trigger <name>` | Toggle cron scheduling |
| `skip-list` | View/manage disabled automations |

## Running Tests

```bash
# Unit tests (498 tests)
npm run test:unit

# Watch mode
npm run test:unit:watch

# E2E tests (requires app running on localhost:3000)
npm run test:e2e

# E2E with browser visible
cd web && npx playwright test --headed
```

## Web UI Pages

| Page | URL | Description |
|---|---|---|
| Dashboard | `/` | Overview: automations, recent runs, today's spend |
| Automations | `/automations` | Browse, create, edit, run, delete automations |
| History | `/history` | Execution logs with filtering |
| Analytics | `/analytics` | Token usage, cost trends, per-agent stats |
| MCP Servers | `/mcp` | Test and configure MCP server connections |
| Env Variables | `/env-vars` | Manage environment variables |
| Settings | `/settings` | Throttle and budget configuration |

## Defining Automations

### Claude-mode (.md)

For tasks that need LLM reasoning — the agent gets your instructions plus MCP server access:

```yaml
---
name: check-mrs
description: Check my open MRs
trigger: manual          # manual | cron
timeout: 120             # seconds
mcp: [gitlab, jira]      # MCP servers to enable
model: sonnet            # LLM model
sandbox: false           # run in isolated Docker container
---

# Check Open Merge Requests

1. Use GitLab MCP to list my open MRs
2. For each MR, check CI status, review status, age
3. Flag MRs older than 3 days without review
4. Output a summary table sorted by urgency
```

### Shell-mode (.yaml)

For deterministic, repeatable scripts. Supports `shell` and `http` step types:

```yaml
name: sync-api-specs
description: Regenerate API clients
trigger: cron
schedule: "0 */4 * * *"
timeout: 180
steps:
  - shell: cd /path/to/project && npm run generate-api
  - shell: cd /path/to/project && npm run fix-ts-errors
  - shell: cd /path/to/project && npx tsc --noEmit
```

#### HTTP steps

Make API calls without needing an LLM or shell:

```yaml
name: health-check
trigger: cron
schedule: "*/30 * * * *"
steps:
  - http:
      url: https://api.example.com/health
      method: GET
      timeout: 10
  - http:
      url: https://api.example.com/deploy
      method: POST
      headers:
        Authorization: "Bearer ${DEPLOY_TOKEN}"
      body:
        environment: production
```

### Composed (.yaml)

Chain multiple automations into a workflow:

```yaml
name: morning-routine
description: Morning routine
trigger: cron
schedule: "0 9 * * 1-5"
compose:
  - check-mrs
  - sync-api-specs
on_complete:
  mattermost: "Morning routine complete. {{summary}}"
```

### Webhook-triggered (.md)

For automations that should run in response to GitLab events (MR opened, pipeline failed, push):

```yaml
---
name: on-mr-opened
description: Auto-check MR when opened
trigger: webhook
timeout: 120
mcp: [gitlab]
model: sonnet
---

# On MR Opened

1. Check $GITLAB_EVENT_TYPE — only proceed if "merge_request"
2. Use $GITLAB_EVENT_MR_IID to fetch MR details
3. Review the diff and output a summary
```

When a GitLab webhook fires, the automation receives these environment variables:

| Variable | Description | Example |
|---|---|---|
| `GITLAB_EVENT_TYPE` | Normalized event type | `push`, `merge_request`, `pipeline` |
| `GITLAB_EVENT_PAYLOAD` | Full webhook JSON body | `{"object_kind":"push",...}` |
| `GITLAB_EVENT_PROJECT` | Project path | `group/repo` |
| `GITLAB_EVENT_REF` | Git ref (push events) | `refs/heads/main` |
| `GITLAB_EVENT_MR_IID` | MR number (MR events) | `123` |
| `GITLAB_EVENT_ACTION` | MR action (MR events) | `open`, `update`, `merge` |
| `GITLAB_EVENT_PIPELINE_STATUS` | Pipeline status | `success`, `failed` |

**GitLab webhook setup:**
1. Go to your GitLab project → Settings → Webhooks
2. URL: `https://<your-host>/api/webhook/gitlab`
3. Secret token: value of `GITLAB_WEBHOOK_SECRET` from your `.env`
4. Select events: Push, Merge request, Pipeline, etc.

All `trigger: webhook` automations fire on every incoming event. The automation itself should check `GITLAB_EVENT_TYPE` and exit early if the event is irrelevant.

## Notifications

Automations can send notifications to multiple channels after each run. Configure globally via env vars and per-automation via the `notify` frontmatter field.

### Channels

| Channel | Env vars | Body format |
|---|---|---|
| Webhook (Slack/Mattermost) | `WEBHOOK_URL` | `{ "text": "..." }` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram Bot API |
| Mattermost (dedicated) | `MATTERMOST_WEBHOOK_URL` | `{ "text": "..." }` |

### Per-automation config

```yaml
# Send to all configured channels
notify: true

# Disable notifications
notify: false

# Selective: only Telegram, and only on failure
notify:
  telegram: on_failure

# Multiple channels with conditions
notify:
  webhook: true
  telegram: on_failure
  mattermost: on_success
```

Conditions: `true`, `false`, `on_failure`, `on_success`.

You can also configure per-channel notifications from the **web UI**: edit an automation → toggle "Enable notifications" → set each channel (Webhook, Telegram, Mattermost) individually.

### Telegram Setup

#### 1. Create a Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a display name (e.g. "Automation Notifier")
4. Choose a username ending with `bot` (e.g. `my_automation_bot`)
5. BotFather will reply with your **bot token** — looks like `123456789:ABCdefGHIjklMNO-pqrSTUvwxYZ`

#### 2. Get your Chat ID

**For a personal chat:**
1. Send any message to your new bot in Telegram
2. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
3. Find `"chat":{"id":123456789}` in the response — that number is your chat ID

**For a group chat:**
1. Add your bot to the group
2. Send a message in the group
3. Check `getUpdates` as above — group IDs are negative (e.g. `-1001234567890`)

#### 3. Add credentials

**Option A — Web UI:** Go to **Env Variables** (`/env-vars`) and add:

| Name | Value |
|------|-------|
| `TELEGRAM_BOT_TOKEN` | `123456789:ABCdefGHI...` |
| `TELEGRAM_CHAT_ID` | `-1001234567890` |

**Option B — `.env` file:** Add the same variables and restart the app.

#### 4. Enable per automation

Edit any automation in the web UI → toggle **Enable notifications** → set **Telegram** to **Always** (or **On failure only**, etc.) → Save.

Or in YAML frontmatter:

```yaml
notify:
  telegram: true          # always
  telegram: on_failure    # only on failure
```

In composed automations, `on_complete` keys route to named channels:

```yaml
on_complete:
  mattermost: "Morning routine complete. {{summary}}"
  telegram: "Done!"
```

## Throttle, Budget & Skip-List

Three layers of protection prevent runaway spending and resource waste. All configurable from the **Settings** page in the web UI (`/settings`).

### Throttle

Controls how often and how many automations can run concurrently. Disabled by default.

| Setting | Default | Description |
|---|---|---|
| `enabled` | `false` | Master switch for all throttle limits |
| `maxConcurrent` | `3` | Max automations running at the same time |
| `maxPerHour` | `20` | Max runs per hour for a specific automation |
| `cooldownSeconds` | `0` | Min seconds between consecutive runs of the same automation |

When a cron trigger fires and a throttle limit is hit, the run is silently skipped (logged as "Cron throttled").

### Budget

Prevents daily overspend by predicting the cost of the next run before executing. Uses EMA (Exponential Moving Average) of the last 10 runs to estimate cost.

| Setting | Default | Description |
|---|---|---|
| `enabled` | `false` | Master switch for budget gating |
| `dailyBudget` | `1.00` | Max daily spend in USD |
| `reservePercent` | `10` | Percentage of daily budget held as buffer |
| `workHoursStart` | `8` | Work hours start (UTC, 0-23) |
| `workHoursEnd` | `18` | Work hours end (UTC, 0-23) |
| `offHoursMultiplier` | `1.5` | Cost weight multiplier for off-hours runs |

Additional protections:
- **Rate-limit backoff**: if Claude API returns rate-limit errors, estimated cost is multiplied by 2^N (exponential backoff). After 3 consecutive rate-limit errors, all cron runs are blocked.
- **Low confidence pass-through**: with fewer than 3 historical runs, budget gating allows runs (benefit of the doubt).

### Skip-List

Automatically disables automations after consecutive failures to prevent burning budget on broken tasks.

- After **2 consecutive failures**, the automation is added to the skip-list
- Skipped automations are silently skipped on cron triggers
- A successful run clears the failure counter
- Individual entries can be cleared via the **Retry** button in the web UI

### Execution order

When a cron job fires, these checks run in sequence:

```
1. Duplicate guard    → is this automation already running?
2. Throttle check     → concurrency / cooldown / hourly rate limits
3. Budget check       → can we afford the estimated cost?
4. Skip-list check    → has this automation been auto-disabled?
5. Execute            → run the automation
```

If any check fails, the run is skipped and the reason is logged.

## How Claude is Invoked

Claude-mode automations run via the Claude CLI:

```
echo "<prompt>" | claude \
  --print --verbose --output-format stream-json \
  --dangerously-skip-permissions \
  --model <model> --max-turns 10 --effort max \
  --mcp-config /tmp/mcp-<uuid>.json
```

Before invocation, the runner:
1. Resolves `${VAR}` placeholders in MCP config from environment
2. Converts relative paths to absolute
3. Writes a temp config file

Output is parsed as NDJSON stream — cost, tokens, errors, and text are extracted in real-time.

**Sandbox mode** wraps the same command in `docker run` with isolation: read-only fs, 1GB memory, 1 CPU, 256 pids, `no-new-privileges`.

## Docker Architecture

```
entrypoint.sh        # Detects Docker socket GID, drops to claude user
Dockerfile           # Production image (node:24-slim, claude CLI, gosu)
sandbox.Dockerfile   # Isolated sandbox image for sandbox-mode automations
docker-compose.yml   # db (Postgres), web (Next.js), daemon (cron), sandbox-image (build)
```

The web service runs as a non-root `claude` user. The entrypoint auto-detects the Docker socket GID at runtime for sandbox container spawning.

### docker-compose.override.yml

Per-developer host mounts (gitignored). Example for shell automations that need host paths:

```yaml
services:
  web:
    volumes:
      - /home/user/work/projects:/home/user/work/projects
  daemon:
    volumes:
      - /home/user/work/projects:/home/user/work/projects
```

## MCP Servers

Configured in `mcp.json`. Credentials come from `.env`:

| Server | Purpose | Env vars |
|--------|---------|----------|
| `gitlab` | GitLab API (MRs, pipelines) | `GITLAB_URL`, `GITLAB_TOKEN` |
| `jira` | Jira issues (search, transitions) | `JIRA_URL`, `JIRA_TOKEN`, `JIRA_JSESSIONID` |
| `mattermost` | Messaging (send, threads) | `MATTERMOST_URL`, `MATTERMOST_TOKEN` |

## Architecture

```
automations/              # Automation definitions (.md, .yaml)
src/
  ├── index.ts            # CLI entry (commander)
  ├── loader.ts           # Parses .md (gray-matter) and .yaml (js-yaml)
  ├── runner.ts           # Executes: Claude CLI for .md, bash for .yaml
  ├── scheduler.ts        # Cron scheduling + throttle/budget/skip-list gating
  ├── composer.ts         # Chains automations, passes context
  ├── notifier.ts         # Multi-channel notifications (webhook, Telegram, Mattermost)
  ├── history.ts          # PostgreSQL execution log + settings storage
  ├── usage-tracker.ts    # Budget prediction (EMA cost estimation, rate-limit backoff)
  ├── skip-list.ts        # Auto-disable automations after consecutive failures
  ├── repl.ts             # Interactive REPL (readline)
  ├── logger.ts           # Pino logger
  └── types.ts            # Zod schemas and TypeScript types
web/                      # Next.js web UI + API routes
mcp-servers/              # MCP server implementations (gitlab, jira, mattermost)
tests/                    # Vitest unit tests
web/tests/                # Playwright e2e tests
```
