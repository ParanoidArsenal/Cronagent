/**
 * Tests for the runner preserving log_file on failed runs.
 *
 * Before this fix: when Claude failed (timeout, max turns, exit code != 0),
 * the catch block built an ExecutionResult without logFile, so the DB lost
 * the path to the on-disk log file even though it was written.
 *
 * After: errors thrown from executeClaudeMode carry a `logFile` property,
 * the retry loop stores it in `lastLogFile`, and the failure ExecutionResult
 * includes it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Automation } from '@cronagent/types';

// ── Mock execa ───────────────────────────────────────────────────────────────

const mockExeca = vi.fn();

vi.mock('execa', () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

// ── Mock fs ──────────────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock prompt content'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock logger ──────────────────────────────────────────────────────────────

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import under test ────────────────────────────────────────────────────────

import { Runner } from '../src/runner.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    name: 'test-auto',
    description: 'test',
    trigger: 'manual',
    schedule: null,
    timeout: 60,
    mcp: [],
    model: 'sonnet',
    instructions: 'Do the thing.',
    filePath: '/tmp/test.md',
    mode: 'claude',
    sandbox: false,
    maxRetries: 0,
    retryDelayMs: 100,
    ...overrides,
  };
}

function makeClaudeStream(lines: string[], exitCode = 0, stderr = '') {
  const resolved = { exitCode, stdout: lines, stderr };
  return Object.assign(Promise.resolve(resolved), {
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (const line of lines) yield line;
      },
    },
    stderr,
    exitCode,
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line;
    },
  });
}

function resultEvent(result = 'done'): string {
  return JSON.stringify({
    type: 'result',
    is_error: false,
    result,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function maxTurnsErrorEvent(): string {
  return JSON.stringify({
    type: 'result',
    is_error: true,
    errors: ['Reached maximum number of turns (12)'],
    usage: {},
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runner preserves logFile on failure', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new Runner(undefined, false);
  });

  it('includes logFile in result when claude exits successfully', async () => {
    mockExeca.mockReturnValue(makeClaudeStream([resultEvent()]));

    const result = await runner.execute(makeAutomation());

    expect(result.success).toBe(true);
    expect(result.logFile).toBeDefined();
    expect(result.logFile).toMatch(/test-auto.*\.log$/);
  });

  it('includes logFile in result when claude reports a max-turns error', async () => {
    mockExeca.mockReturnValue(makeClaudeStream([maxTurnsErrorEvent()]));

    const result = await runner.execute(makeAutomation());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Reached maximum number of turns');
    expect(result.logFile).toBeDefined();
    expect(result.logFile).toMatch(/test-auto.*\.log$/);
  });

  it('includes logFile in result when claude exits with non-zero code', async () => {
    mockExeca.mockReturnValue(makeClaudeStream([], 1, 'some stderr error'));

    const result = await runner.execute(makeAutomation());

    expect(result.success).toBe(false);
    expect(result.logFile).toBeDefined();
    expect(result.logFile).toMatch(/test-auto.*\.log$/);
  });

  it('includes logFile in result when claude is killed (SIGTERM, exit 143)', async () => {
    mockExeca.mockReturnValue(makeClaudeStream([], 143, ''));

    const result = await runner.execute(makeAutomation());

    expect(result.success).toBe(false);
    expect(result.error).toContain('SIGTERM');
    expect(result.logFile).toBeDefined();
    expect(result.logFile).toMatch(/test-auto.*\.log$/);
  });

  it('includes logFile in result when claude is killed (SIGKILL, exit 137)', async () => {
    mockExeca.mockReturnValue(makeClaudeStream([], 137, ''));

    const result = await runner.execute(makeAutomation());

    expect(result.success).toBe(false);
    expect(result.error).toContain('SIGKILL');
    expect(result.logFile).toBeDefined();
    expect(result.logFile).toMatch(/test-auto.*\.log$/);
  });

  it('preserves logFile from the LAST attempt across retries', async () => {
    // First attempt fails, second succeeds — both should have a logFile.
    mockExeca
      .mockReturnValueOnce(makeClaudeStream([maxTurnsErrorEvent()]))
      .mockReturnValueOnce(makeClaudeStream([resultEvent('recovered')]));

    const result = await runner.execute(
      makeAutomation({ maxRetries: 1, retryDelayMs: 1 }),
    );

    expect(result.success).toBe(true);
    expect(result.logFile).toBeDefined();
    expect(result.attemptNumber).toBe(2);
  });

  it('preserves logFile even when ALL retries fail', async () => {
    mockExeca
      .mockReturnValueOnce(makeClaudeStream([maxTurnsErrorEvent()]))
      .mockReturnValueOnce(makeClaudeStream([maxTurnsErrorEvent()]));

    const result = await runner.execute(
      makeAutomation({ maxRetries: 1, retryDelayMs: 1 }),
    );

    expect(result.success).toBe(false);
    expect(result.totalAttempts).toBe(2);
    expect(result.logFile).toBeDefined();
    expect(result.logFile).toMatch(/test-auto.*\.log$/);
  });
});
