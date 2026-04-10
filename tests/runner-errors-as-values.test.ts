/**
 * Tests for the "errors as values" contract of Runner.execute().
 *
 * The refactor (7283d9c) changed Runner.execute() to ALWAYS return an
 * ExecutionResult — even for abort signals and unexpected I/O errors that
 * previously threw. These tests lock in that contract.
 *
 * Coverage gaps addressed:
 * 1. Abort signal path (src/runner.ts:167-176) — previously untested throw,
 *    now a returned failed result.
 * 2. Unexpected I/O error catch block in executeClaudeMode (src/runner.ts:591-600)
 *    — catches errors from writeFile/resolvedMcpConfig/etc. and converts to
 *    ModeResult, including tmpFile cleanup in the finally block.
 * 3. Never-throws contract — execute() must always resolve, never reject.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { execaMock, notifyMock, writeFileMock, rmMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
  notifyMock: vi.fn(async () => {}),
  writeFileMock: vi.fn(async () => {}),
  rmMock: vi.fn(async () => {}),
}));

// ── Mock logger ──────────────────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock execa ───────────────────────────────────────────────────────────────

vi.mock('execa', () => ({
  execa: execaMock,
}));

// ── Mock fs ──────────────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'mock prompt content'),
  writeFile: writeFileMock,
  rm: rmMock,
  mkdir: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { Runner } from '../src/runner.js';
import type { Automation } from '../src/types.js';
import type { Notifier } from '../src/notifier.js';

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
    mode: 'shell',
    sandbox: false,
    maxRetries: 0,
    retryDelayMs: 100,
    ...overrides,
  };
}

function makeClaudeStream(lines: string[], exitCode = 0, stderr = '') {
  const resolved = { exitCode, stdout: lines, stderr };
  return Object.assign(Promise.resolve(resolved), {
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Runner — errors as values contract', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    const notifier = { notify: notifyMock } as unknown as Notifier;
    runner = new Runner(undefined, false, notifier);
  });

  // ── 1. Abort signal path ─────────────────────────────────────────────────

  describe('abort signal', () => {
    it('returns failed result when signal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await runner.execute(
        makeAutomation(),
        undefined, undefined, undefined,
        controller.signal,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Run stopped by user');
      expect(result.attemptNumber).toBe(1);
      expect(result.totalAttempts).toBe(1);
    });

    it('does not dispatch any mode when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await runner.execute(
        makeAutomation(),
        undefined, undefined, undefined,
        controller.signal,
      );

      expect(execaMock).not.toHaveBeenCalled();
    });

    it('calls notifier on abort', async () => {
      const controller = new AbortController();
      controller.abort();

      await runner.execute(
        makeAutomation(),
        undefined, undefined, undefined,
        controller.signal,
      );

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const notified = notifyMock.mock.calls[0][0];
      expect(notified.success).toBe(false);
      expect(notified.error).toBe('Run stopped by user');
    });

    it('catches abort between retries and reports correct attempt number', async () => {
      vi.useFakeTimers();

      const controller = new AbortController();
      execaMock.mockRejectedValueOnce(new Error('transient'));

      const promise = runner.execute(
        makeAutomation({ maxRetries: 2, retryDelayMs: 100 }),
        undefined, undefined, undefined,
        controller.signal,
      );

      // Flush microtasks so attempt 1 completes and retry delay is registered
      await vi.advanceTimersByTimeAsync(0);

      // Abort during the retry delay
      controller.abort();

      // Advance past the delay — attempt 2 sees the aborted signal
      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Run stopped by user');
      expect(result.attemptNumber).toBe(2);
      expect(execaMock).toHaveBeenCalledTimes(1);
    });

    it('populates mode and automationName on the abort result', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await runner.execute(
        makeAutomation({ name: 'my-auto', mode: 'claude' }),
        undefined, undefined, undefined,
        controller.signal,
      );

      expect(result.automationName).toBe('my-auto');
      expect(result.mode).toBe('claude');
    });
  });

  // ── 2. Unexpected I/O errors in executeClaudeMode ────────────────────────

  describe('executeClaudeMode unexpected errors', () => {
    it('returns failed result when writeFile rejects', async () => {
      writeFileMock.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      const result = await runner.execute(makeAutomation({ mode: 'claude' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOSPC');
      expect(result.attemptNumber).toBe(1);
    });

    it('runs finally cleanup even when catch block fires', async () => {
      writeFileMock.mockRejectedValueOnce(new Error('disk error'));

      await runner.execute(makeAutomation({ mode: 'claude' }));

      // The finally block calls rm(tmpFile) — tmpFile is set before writeFile
      expect(rmMock).toHaveBeenCalled();
    });

    it('retries after unexpected error and can succeed on next attempt', async () => {
      vi.useFakeTimers();

      // First attempt: writeFile rejects (unexpected I/O error in claude mode)
      writeFileMock.mockRejectedValueOnce(new Error('transient disk error'));
      // Subsequent: writeFile succeeds (default mock restored after once)

      // Second attempt: full claude stream succeeds
      execaMock.mockReturnValueOnce(makeClaudeStream([resultEvent('recovered')]));

      const promise = runner.execute(
        makeAutomation({ mode: 'claude', maxRetries: 1, retryDelayMs: 50 }),
      );

      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.output).toBe('recovered');
      expect(result.attemptNumber).toBe(2);
    });

    it('notifier receives the I/O error on final failure', async () => {
      writeFileMock.mockRejectedValueOnce(new Error('persistent disk error'));

      await runner.execute(makeAutomation({ mode: 'claude' }));

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0][0].error).toContain('persistent disk error');
    });
  });

  // ── 3. Never-throws contract ─────────────────────────────────────────────

  describe('execute() never-throws contract', () => {
    it('resolves (not rejects) with pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        runner.execute(
          makeAutomation(),
          undefined, undefined, undefined,
          controller.signal,
        ),
      ).resolves.toMatchObject({ success: false });
    });

    it('resolves (not rejects) on unexpected I/O error in claude mode', async () => {
      writeFileMock.mockRejectedValueOnce(new Error('unexpected crash'));

      await expect(
        runner.execute(makeAutomation({ mode: 'claude' })),
      ).resolves.toMatchObject({ success: false });
    });

    it('resolves (not rejects) when shell mode command throws', async () => {
      execaMock.mockRejectedValueOnce(new Error('command not found'));

      await expect(
        runner.execute(makeAutomation({ mode: 'shell' })),
      ).resolves.toMatchObject({ success: false });
    });

    it('resolves (not rejects) when caila mode throws (missing credentials)', async () => {
      await expect(
        runner.execute(makeAutomation({ mode: 'caila' })),
      ).resolves.toMatchObject({ success: false });
    });
  });
});
