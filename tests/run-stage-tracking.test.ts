/**
 * Structural tests for live run stage tracking.
 *
 * These tests follow the source-inspection pattern from tests/log-file.test.ts
 * — we don't spin up a Postgres; we assert that the schema/runner/backend/UI
 * wiring is present and consistent.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let historySrc: string;
let runnerSrc: string;
let parserSrc: string;
let backendSrc: string;
let schedulerSrc: string;
let runsPage: string;

beforeAll(async () => {
  historySrc = await readFile(resolve(__dirname, '../src/history.ts'), 'utf-8');
  runnerSrc = await readFile(resolve(__dirname, '../src/runner.ts'), 'utf-8');
  parserSrc = await readFile(resolve(__dirname, '../src/claude-stream-parser.ts'), 'utf-8');
  backendSrc = await readFile(resolve(__dirname, '../web/lib/backend.ts'), 'utf-8');
  schedulerSrc = await readFile(resolve(__dirname, '../src/scheduler.ts'), 'utf-8');
  runsPage = await readFile(resolve(__dirname, '../web/app/runs/[id]/page.tsx'), 'utf-8');
});

describe('history.ts — schema migration', () => {
  it('adds status column', () => {
    expect(historySrc).toContain('ADD COLUMN IF NOT EXISTS status TEXT');
  });
  it('adds current_stage column', () => {
    expect(historySrc).toContain('ADD COLUMN IF NOT EXISTS current_stage TEXT');
  });
  it('adds turn_count column', () => {
    expect(historySrc).toContain('ADD COLUMN IF NOT EXISTS turn_count INTEGER');
  });
  it('drops NOT NULL on success', () => {
    expect(historySrc).toContain('ALTER COLUMN success DROP NOT NULL');
  });
  it('drops NOT NULL on finished_at', () => {
    expect(historySrc).toContain('ALTER COLUMN finished_at DROP NOT NULL');
  });
  it('creates a partial index on running status', () => {
    expect(historySrc).toMatch(/idx_run_history_status[\s\S]*WHERE status = 'running'/);
  });
  it('creates a unique partial index to prevent duplicate running rows per automation', () => {
    expect(historySrc).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_one_running_per_automation/);
    expect(historySrc).toMatch(/idx_one_running_per_automation[\s\S]*WHERE status = 'running'/);
  });
});

describe('history.ts — RunRecord interface', () => {
  it('allows null success', () => {
    expect(historySrc).toMatch(/success:\s*boolean\s*\|\s*null/);
  });
  it('allows null finished_at', () => {
    expect(historySrc).toMatch(/finished_at:\s*Date\s*\|\s*null/);
  });
  it('has status field', () => {
    expect(historySrc).toMatch(/status:\s*'running'\s*\|\s*'success'\s*\|\s*'failed'\s*\|\s*null/);
  });
  it('has current_stage field', () => {
    expect(historySrc).toMatch(/current_stage:\s*string\s*\|\s*null/);
  });
  it('has turn_count field', () => {
    expect(historySrc).toMatch(/turn_count:\s*number\s*\|\s*null/);
  });
});

describe('history.ts — insertRunning unique-violation handling', () => {
  it('returns number | null from insertRunning', () => {
    expect(historySrc).toMatch(/async insertRunning\([^)]*\):\s*Promise<number \| null>/);
  });
  it('catches PG unique-violation code 23505 and returns null', () => {
    expect(historySrc).toContain("'23505'");
    expect(historySrc).toMatch(/code.*===.*'23505'[\s\S]*return null/);
  });
});

describe('history.ts — lifecycle methods', () => {
  it('exposes insertRunning', () => {
    expect(historySrc).toContain('async insertRunning(');
  });
  it('exposes updateProgress', () => {
    expect(historySrc).toContain('async updateProgress(');
  });
  it('exposes finalizeRun', () => {
    expect(historySrc).toContain('async finalizeRun(');
  });
  it('sweeps orphaned running rows on startup', () => {
    expect(historySrc).toMatch(/UPDATE run_history[\s\S]*status = 'failed'[\s\S]*WHERE status = 'running'/);
  });
});

describe('runner.ts — onProgress callback', () => {
  it('imports ProgressCallback type', () => {
    expect(runnerSrc).toContain('ProgressCallback');
  });
  it('accepts onProgress parameter in execute', () => {
    expect(runnerSrc).toMatch(/onProgress\?:\s*ProgressCallback/);
  });
  it('emits a tool_use stage label (in extracted ClaudeStreamParser)', () => {
    expect(parserSrc).toContain('tool_use:');
  });
  it('emits a thinking stage label (in extracted ClaudeStreamParser)', () => {
    expect(parserSrc).toContain("'thinking'");
  });
  it('throttles progress via a min interval (in extracted ClaudeStreamParser)', () => {
    expect(parserSrc).toContain('PROGRESS_MIN_INTERVAL_MS');
  });
});

describe('backend.ts — triggerRun integration', () => {
  it('calls insertRunning before execution', () => {
    expect(backendSrc).toContain('history.insertRunning');
  });
  it('calls finalizeRun after execution', () => {
    expect(backendSrc).toContain('history.finalizeRun');
  });
  it('passes onProgress into runner.execute', () => {
    expect(backendSrc).toMatch(/runner\.execute\([^)]*onProgress[^)]*\)/);
  });
  it('returns runId to callers', () => {
    expect(backendSrc).toMatch(/return\s*\{\s*started:\s*true,\s*runId\s*\}/);
  });
  it('returns already_running when insertRunning returns null', () => {
    expect(backendSrc).toMatch(/maybeRunId === null/);
    expect(backendSrc).toMatch(/reason:\s*'already_running'/);
  });
});

describe('scheduler.ts — cron integration', () => {
  it('uses insertRunning for cron-triggered runs', () => {
    expect(schedulerSrc).toContain('insertRunning');
  });
  it('finalizes the row after execution', () => {
    expect(schedulerSrc).toContain('finalizeRun');
  });
  it('skips execution when insertRunning returns null (DB constraint)', () => {
    expect(schedulerSrc).toMatch(/maybeRunId === null/);
    expect(schedulerSrc).toContain('already running (DB constraint)');
  });
});

describe('runs detail page — running view', () => {
  it('imports RunningPanel', () => {
    expect(runsPage).toContain('RunningPanel');
  });
  it('auto-refreshes while running', () => {
    expect(runsPage).toMatch(/AutoRefresh[\s\S]*intervalMs=\{2000\}/);
  });
  it('branches on status === running', () => {
    expect(runsPage).toContain("record.status === 'running'");
  });
  it('null-guards finished_at', () => {
    expect(runsPage).toContain('record.finished_at ? String(record.finished_at)');
  });
});
