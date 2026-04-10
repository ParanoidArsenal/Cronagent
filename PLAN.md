# Personal Automation REPL

## Problem
One-off automations keep becoming mini-projects (jira-fetcher, shell scripts, workflow-kit commands). Need a single place to define, run, compose, and version all micro-automations.

## Approach
New project combining `claude-cron`'s scheduling + `ai-pipelines`'s MCP ecosystem + `claude-workflow-kit`'s command pattern into a unified automation hub.

## Architecture

```
cronagent/
├── automations/           # Each automation is a .md or .yaml file
│   ├── standup-prep.md
│   ├── check-mrs.md
│   ├── sync-api-specs.md
│   └── weekly-digest.md
├── src/
│   ├── index.ts           # CLI entry point
│   ├── loader.ts          # Parse automation definitions
│   ├── runner.ts          # Execute automations (shell, claude, MCP)
│   ├── scheduler.ts       # Cron scheduling (reuse claude-cron's Scheduler)
│   ├── history.ts         # SQLite execution log (reuse claude-cron's RunRepository)
│   ├── composer.ts        # Chain automations together
│   └── repl.ts            # Interactive REPL mode
├── mcp.json               # MCP servers (copy from ai-pipelines)
├── config.yaml            # Global config (repos, credentials, defaults)
└── package.json
```

## Implementation

### Step 1: Define the automation format

**Claude-mode automations** (`automations/*.md`):
```yaml
---
name: check-mrs
description: Check status of all my open MRs across projects
trigger: manual                    # manual | cron | webhook
schedule: null                     # cron expression if trigger=cron
timeout: 60                        # seconds
mcp: [gitlab, jira]               # which MCP servers to enable
---

## Steps
1. Use GitLab MCP to list my open MRs across all projects
2. For each MR, check: CI status, review status, age
3. Flag: MRs older than 3 days without review, MRs with failing CI
4. Output a summary table sorted by urgency
```

**Shell-mode automations** (`automations/*.yaml`):
```yaml
name: sync-api-specs
description: Download latest API specs for my-app
trigger: cron
schedule: "0 */4 * * *"
steps:
  - shell: cd ~/projects/my-app
  - shell: npm run generate-api
  - shell: npm run fix-ts-errors
  - shell: npx tsc --noEmit
  - on_failure:
      mattermost: "API spec sync failed: {{error}}"
```

### Step 2: Build the loader
**File:** `src/loader.ts`
- Scan `automations/` directory for `.md` and `.yaml` files
- Parse frontmatter (for .md) or YAML structure
- Validate: name uniqueness, required fields, valid cron expressions
- Return typed `Automation[]` array

Reuse patterns from:
- `ai-pipelines/agent-runner/agentManager.js` (loads .md agent definitions)
- `claude-cron/src/config/` (YAML config validation)

### Step 3: Build the runner
**File:** `src/runner.ts`

Two execution modes:
1. **Claude mode** (`.md` automations): spawn `claude` CLI with instructions + MCP config
2. **Shell mode** (`.yaml` with `steps`): execute shell commands sequentially, capture output, handle `on_failure`

Reuse:
- `claude-cron/src/executor/executor.ts` — Claude CLI spawning, output capture, cost tracking
- `claude-cron/src/storage/` — SQLite for execution history

### Step 4: Build the REPL
**File:** `src/repl.ts`

Interactive mode: `npx cronagent`
```
> list                          # show all automations
> run check-mrs                 # execute one
> run check-mrs | sync-specs    # chain: output of first feeds into second
> history check-mrs             # last 10 runs with status/cost
> schedule check-mrs "0 9 * *"  # add cron trigger
> edit check-mrs                # open in $EDITOR
> new "my-automation"           # scaffold a new automation file
> watch                         # tail execution log in real-time
```

CLI mode:
```bash
cronagent run check-mrs
cronagent daemon          # start cron scheduler
```

### Step 5: Add composition (chaining)
**File:** `src/composer.ts`

```yaml
name: morning-routine
trigger: cron
schedule: "0 9 * * 1-5"
compose:
  - standup-prep
  - check-mrs
  - sync-api-specs
on_complete:
  mattermost: "Morning routine complete. {{summary}}"
```

Runs sequentially, passes context between steps, aggregates results.

### Step 6: Claude Code integration
Add `/run` slash command to any project's `.claude/commands/`:
```markdown
# /run <automation-name>
Execute an automation from the personal automation REPL.
Run: `npx --prefix ~/work/sandbox/cronagent cronagent run $ARGUMENTS`
```

## Verification
1. Create 3 test automations: one shell-only, one Claude-mode, one composed
2. Run each via REPL: `npx cronagent run <name>`
3. Check SQLite history: `npx cronagent history`
4. Enable a cron job, verify it fires on schedule
5. Chain two automations, verify context passes correctly

## Key dependencies to reuse
- `claude-cron`: Executor, Scheduler, RunRepository, config validation
- `ai-pipelines`: agent .md format, MCP config, mcp.json
- `claude-workflow-kit`: slash command patterns

## Effort
~6-8 hours
