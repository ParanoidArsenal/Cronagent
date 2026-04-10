/**
 * Unit tests for loadAutomations() in src/loader.ts.
 *
 * Each test creates a fresh temporary directory, writes specific fixture files
 * into it, calls loadAutomations(), and asserts on the returned Automation
 * objects. The directory is deleted in afterEach so tests are fully isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Mock logger so test output stays clean ────────────────────────────────────
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { loadAutomations } from '../src/loader.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a file into tempDir and return the resolved path (unused but handy). */
async function write(tempDir: string, filename: string, content: string): Promise<string> {
  const filePath = join(tempDir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('loadAutomations()', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'loader-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── 1. Valid .md file ───────────────────────────────────────────────────────

  it('loads a valid .md file with frontmatter and returns a correct Automation object', async () => {
    await write(
      tempDir,
      'greet.md',
      `---
name: greet
description: A simple greeting automation
trigger: manual
---
Say hello to the world.
`,
    );

    const automations = await loadAutomations(tempDir);

    expect(automations).toHaveLength(1);
    const a = automations[0];
    expect(a.name).toBe('greet');
    expect(a.description).toBe('A simple greeting automation');
    expect(a.trigger).toBe('manual');
    expect(a.instructions).toBe('Say hello to the world.');
    expect(a.filePath).toContain('greet.md');
  });

  // ── 2. Valid shell .yaml file with steps ───────────────────────────────────

  it('loads a valid shell .yaml file with steps and sets mode to shell', async () => {
    await write(
      tempDir,
      'cleanup.yaml',
      `name: cleanup
description: Remove temp files
steps:
  - shell: rm -rf /tmp/old-files
  - shell: echo done
`,
    );

    const automations = await loadAutomations(tempDir);

    expect(automations).toHaveLength(1);
    const a = automations[0];
    expect(a.name).toBe('cleanup');
    expect(a.mode).toBe('shell');
    expect(a.instructions).toContain('$ rm -rf /tmp/old-files');
    expect(a.instructions).toContain('$ echo done');
  });

  // ── 3. Valid composed .yaml file with compose array ────────────────────────

  it('loads a valid composed .yaml file with compose array', async () => {
    await write(
      tempDir,
      'pipeline.yaml',
      `name: pipeline
description: Run steps in order
compose:
  - step-one
  - step-two
  - step-three
`,
    );

    const automations = await loadAutomations(tempDir);

    expect(automations).toHaveLength(1);
    const a = automations[0];
    expect(a.name).toBe('pipeline');
    expect(a.mode).toBe('shell');
  });

  // ── 4. .md files default to mode 'claude' ─────────────────────────────────

  it('sets mode to claude for .md files when no mode is specified in frontmatter', async () => {
    await write(
      tempDir,
      'analysis.md',
      `---
name: analysis
---
Analyse the codebase.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.mode).toBe('claude');
  });

  // ── 5. .md files with mode: caila ─────────────────────────────────────────

  it('sets mode to caila when frontmatter declares mode: caila', async () => {
    await write(
      tempDir,
      'caila-task.md',
      `---
name: caila-task
mode: caila
---
Prompt for Caila.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.mode).toBe('caila');
  });

  // ── 6. .yaml with steps sets mode to 'shell' ──────────────────────────────

  it('sets mode to shell for .yaml files containing steps', async () => {
    await write(
      tempDir,
      'runner.yaml',
      `name: runner
steps:
  - shell: echo hi
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.mode).toBe('shell');
  });

  // ── 7. Composed .yaml stores compose definition as JSON in instructions ────

  it('stores the compose definition as a JSON string in instructions for composed .yaml', async () => {
    await write(
      tempDir,
      'composed.yaml',
      `name: composed
compose:
  - alpha
  - beta
on_complete:
  notify: "done"
`,
    );

    const [a] = await loadAutomations(tempDir);
    const parsed = JSON.parse(a.instructions);
    expect(parsed.compose).toEqual(['alpha', 'beta']);
    expect(parsed.on_complete).toEqual({ notify: 'done' });
  });

  // ── 8. Empty directory returns empty array ─────────────────────────────────

  it('returns an empty array for an empty directory', async () => {
    const automations = await loadAutomations(tempDir);
    expect(automations).toEqual([]);
  });

  // ── 9. Skips files with invalid frontmatter without crashing ───────────────

  it('skips .md files with invalid frontmatter and continues loading the rest', async () => {
    // Missing required `name` field — will fail Zod parse
    await write(
      tempDir,
      'broken.md',
      `---
description: This has no name field
---
Body text.
`,
    );

    await write(
      tempDir,
      'valid.md',
      `---
name: valid-auto
---
Valid instructions.
`,
    );

    const automations = await loadAutomations(tempDir);

    expect(automations).toHaveLength(1);
    expect(automations[0].name).toBe('valid-auto');
  });

  // ── 10. Skips non-.md/.yaml files ─────────────────────────────────────────

  it('ignores files that are not .md or .yaml/.yml', async () => {
    await write(tempDir, 'readme.txt', 'This is a readme');
    await write(tempDir, 'config.json', '{"key": "value"}');
    await write(tempDir, 'script.sh', '#!/bin/bash\necho hi');

    const automations = await loadAutomations(tempDir);
    expect(automations).toEqual([]);
  });

  // ── 11. Zod schema applies default values ─────────────────────────────────

  it('applies default values from the Zod schema when fields are omitted', async () => {
    await write(
      tempDir,
      'defaults.md',
      `---
name: defaults-check
---
Check defaults.
`,
    );

    const [a] = await loadAutomations(tempDir);

    expect(a.trigger).toBe('manual');
    expect(a.timeout).toBe(300);
    expect(a.mcp).toEqual([]);
    expect(a.model).toBe('sonnet');
    expect(a.sandbox).toBe(false);
    expect(a.maxRetries).toBe(0);
    expect(a.retryDelayMs).toBe(1000);
    expect(a.conversation).toBe(false);
    expect(a.schedule).toBeNull();
  });

  // ── 12. Parses schedule field for cron automations ─────────────────────────

  it('parses the schedule field correctly for a cron automation', async () => {
    await write(
      tempDir,
      'daily.md',
      `---
name: daily-report
trigger: cron
schedule: "0 8 * * *"
---
Generate the daily report.
`,
    );

    const [a] = await loadAutomations(tempDir);

    expect(a.trigger).toBe('cron');
    expect(a.schedule).toBe('0 8 * * *');
  });

  // ── 13. Parses mcp array from frontmatter ─────────────────────────────────

  it('parses the mcp array from frontmatter', async () => {
    await write(
      tempDir,
      'mcp-task.md',
      `---
name: mcp-task
mcp:
  - filesystem
  - github
  - slack
---
Use MCP tools.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.mcp).toEqual(['filesystem', 'github', 'slack']);
  });

  // ── 14a. Parses notify field as boolean ────────────────────────────────────

  it('parses notify as a boolean true from frontmatter', async () => {
    await write(
      tempDir,
      'notify-bool.md',
      `---
name: notify-bool
notify: true
---
Always notify.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.notify).toBe(true);
  });

  it('parses notify as a boolean false from frontmatter', async () => {
    await write(
      tempDir,
      'notify-false.md',
      `---
name: notify-false
notify: false
---
Never notify.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.notify).toBe(false);
  });

  // ── 14b. Parses notify field as an object (channels form) ─────────────────

  it('parses notify as a channel object from frontmatter', async () => {
    await write(
      tempDir,
      'notify-obj.md',
      `---
name: notify-channels
notify:
  webhook: on_failure
  telegram: true
---
Notify on failure via webhook, always via telegram.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.notify).toEqual({ webhook: 'on_failure', telegram: true });
  });

  // ── 15. Loads multiple files and returns all ──────────────────────────────

  it('loads multiple files of different types and returns all as Automation objects', async () => {
    await write(
      tempDir,
      'task-a.md',
      `---
name: task-a
---
Instructions A.
`,
    );

    await write(
      tempDir,
      'task-b.md',
      `---
name: task-b
mode: caila
---
Instructions B.
`,
    );

    await write(
      tempDir,
      'task-c.yaml',
      `name: task-c
steps:
  - shell: echo c
`,
    );

    await write(
      tempDir,
      'task-d.yaml',
      `name: task-d
compose:
  - task-a
  - task-b
`,
    );

    const automations = await loadAutomations(tempDir);

    expect(automations).toHaveLength(4);
    const names = automations.map((a) => a.name).sort();
    expect(names).toEqual(['task-a', 'task-b', 'task-c', 'task-d']);
  });

  // ── Bonus: .yml extension is also accepted ─────────────────────────────────

  it('accepts .yml extension in addition to .yaml', async () => {
    await write(
      tempDir,
      'job.yml',
      `name: yml-job
steps:
  - shell: echo yml
`,
    );

    const automations = await loadAutomations(tempDir);
    expect(automations).toHaveLength(1);
    expect(automations[0].name).toBe('yml-job');
  });

  // ── Bonus: non-existent directory returns empty array ─────────────────────

  it('returns an empty array when the directory does not exist', async () => {
    const automations = await loadAutomations(join(tempDir, 'does-not-exist'));
    expect(automations).toEqual([]);
  });

  // ── Bonus: duplicate automation names are deduplicated ────────────────────

  it('skips duplicate automation names and keeps only the first one loaded', async () => {
    await write(
      tempDir,
      'alpha.md',
      `---
name: duplicated
---
First file.
`,
    );

    await write(
      tempDir,
      'beta.md',
      `---
name: duplicated
---
Second file.
`,
    );

    const automations = await loadAutomations(tempDir);

    // Only one entry with that name should survive
    const matches = automations.filter((a) => a.name === 'duplicated');
    expect(matches).toHaveLength(1);
  });

  // ── Bonus: instructions preserve multi-line body ──────────────────────────

  it('trims and preserves multi-line instruction bodies from .md files', async () => {
    await write(
      tempDir,
      'multi.md',
      `---
name: multi-line
---

Line one.
Line two.
Line three.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.instructions).toBe('Line one.\nLine two.\nLine three.');
  });

  // ── Bonus: shell steps with on_failure handler ────────────────────────────

  it('encodes on_failure steps as JSON in shell automation instructions', async () => {
    await write(
      tempDir,
      'with-failure.yaml',
      `name: with-failure
steps:
  - shell: risky-command
  - on_failure:
      alert: "Command failed"
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.instructions).toContain('$ risky-command');
    expect(a.instructions).toContain('on_failure:');
    expect(a.instructions).toContain('Command failed');
  });

  // ── Bonus: maxRetries and retryDelayMs propagate from frontmatter ─────────

  it('reads maxRetries and retryDelayMs from .md frontmatter', async () => {
    await write(
      tempDir,
      'retries.md',
      `---
name: retry-test
maxRetries: 3
retryDelayMs: 5000
---
Retry me.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.maxRetries).toBe(3);
    expect(a.retryDelayMs).toBe(5000);
  });

  // ── Bonus: conversation flag propagates from frontmatter ──────────────────

  it('reads the conversation flag from .md frontmatter', async () => {
    await write(
      tempDir,
      'conversation.md',
      `---
name: convo-task
conversation: true
---
Keep talking.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.conversation).toBe(true);
  });

  // ── Bonus: sandbox flag propagates from frontmatter ───────────────────────

  it('reads the sandbox flag from .md frontmatter', async () => {
    await write(
      tempDir,
      'sandboxed.md',
      `---
name: sandboxed-task
sandbox: true
---
Run in a box.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.sandbox).toBe(true);
  });

  // ── preCollect field propagates from frontmatter ──────────────────────────

  it('reads the preCollect field from .md frontmatter', async () => {
    await write(
      tempDir,
      'precollect-task.md',
      `---
name: precollect-task
preCollect: bash scripts/collect.sh
---
Use pre-collected data.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.preCollect).toBe('bash scripts/collect.sh');
  });

  it('preCollect is undefined when not specified', async () => {
    await write(
      tempDir,
      'no-precollect.md',
      `---
name: no-precollect
---
No pre-collect.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.preCollect).toBeUndefined();
  });

  // ── systemPrompt field propagates from frontmatter ────────────────────────

  it('reads the systemPrompt field from .md frontmatter', async () => {
    await write(
      tempDir,
      'sysprompt-task.md',
      `---
name: sysprompt-task
systemPrompt: |
  Available tools: foo, bar
  Do not use ToolSearch
---
Use the listed tools.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.systemPrompt).toContain('Available tools: foo, bar');
    expect(a.systemPrompt).toContain('Do not use ToolSearch');
  });

  it('systemPrompt is undefined when not specified', async () => {
    await write(
      tempDir,
      'no-sysprompt.md',
      `---
name: no-sysprompt
---
No system prompt.
`,
    );

    const [a] = await loadAutomations(tempDir);
    expect(a.systemPrompt).toBeUndefined();
  });
});
