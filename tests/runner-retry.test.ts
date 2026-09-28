/**
 * Unit tests for Runner retry logic with exponential backoff.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (referenced in vi.mock factories) ──────────────────────────
const { execaMock, notifyMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
  notifyMock: vi.fn(async () => {}),
}));

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock execa ────────────────────────────────────────────────────────────────
vi.mock('execa', () => ({
  execa: execaMock,
}));

// ── Mock fs ───────────────────────────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'test prompt content'),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
}));

// ── Import after mocks ───────────────────────────────────────────────────────
import { Runner } from '../src/runner.js';
import type { Automation } from '../src/types.js';
import type { Notifier } from '../src/notifier.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    name: 'test-auto',
    description: 'test',
    trigger: 'manual',
    schedule: null,
    timeout: 30,
    mcp: [],
    model: 'sonnet',
    instructions: 'echo hello',
    filePath: '/tmp/test.yaml',
    mode: 'shell',
    sandbox: false,
    maxRetries: 0,
    retryDelayMs: 100,
    ...overrides,
  };
}

function makeExecaSuccess(stdout = 'ok') {
  return { exitCode: 0, stdout, stderr: '' };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Runner', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    const notifier = { notify: notifyMock } as unknown as Notifier;
    runner = new Runner(undefined, false, notifier);
  });

  describe('execute() retry logic', () => {
    it('succeeds on first attempt with maxRetries: 0', async () => {
      execaMock.mockResolvedValueOnce(makeExecaSuccess('hello'));

      const result = await runner.execute(makeAutomation({ maxRetries: 0 }));

      expect(result.success).toBe(true);
      expect(result.output).toBe('hello');
      expect(result.attemptNumber).toBe(1);
      expect(result.totalAttempts).toBe(1);
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it('succeeds on first attempt with maxRetries: 2 — no retries used', async () => {
      execaMock.mockResolvedValueOnce(makeExecaSuccess('good'));

      const result = await runner.execute(makeAutomation({ maxRetries: 2 }));

      expect(result.success).toBe(true);
      expect(result.attemptNumber).toBe(1);
      expect(result.totalAttempts).toBe(1);
      expect(execaMock).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and succeeds on second attempt', async () => {
      vi.useFakeTimers();

      execaMock
        .mockRejectedValueOnce(new Error('transient error'))
        .mockResolvedValueOnce(makeExecaSuccess('recovered'));

      const promise = runner.execute(makeAutomation({ maxRetries: 2, retryDelayMs: 100 }));

      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.output).toBe('recovered');
      expect(result.attemptNumber).toBe(2);
      expect(result.totalAttempts).toBe(2);
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it('fails after exhausting all retries', async () => {
      vi.useFakeTimers();

      execaMock
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'));

      const promise = runner.execute(makeAutomation({ maxRetries: 2, retryDelayMs: 100 }));

      await vi.advanceTimersByTimeAsync(500);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('fail 3');
      expect(result.attemptNumber).toBe(3);
      expect(result.totalAttempts).toBe(3);
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it('notifier is called exactly once regardless of retry count', async () => {
      vi.useFakeTimers();

      execaMock
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(makeExecaSuccess('ok'));

      const promise = runner.execute(makeAutomation({ maxRetries: 1, retryDelayMs: 50 }));
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it('uses 10x delay for rate-limit errors', async () => {
      vi.useFakeTimers();

      execaMock
        .mockRejectedValueOnce(new Error('rate_limit: too many requests'))
        .mockResolvedValueOnce(makeExecaSuccess('ok'));

      const promise = runner.execute(makeAutomation({ maxRetries: 1, retryDelayMs: 100 }));

      // Rate limit delay: 100 * 2^0 * 10 = 1000ms — advancing 500ms should NOT resolve
      await vi.advanceTimersByTimeAsync(500);
      // execa should only have been called once (second call still waiting)
      expect(execaMock).toHaveBeenCalledTimes(1);

      // Now advance past the full 1000ms delay
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(execaMock).toHaveBeenCalledTimes(2);
    });

    it('preserves startedAt from the first attempt', async () => {
      vi.useFakeTimers();
      const beforeStart = new Date();

      execaMock
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(makeExecaSuccess('ok'));

      const promise = runner.execute(makeAutomation({ maxRetries: 1, retryDelayMs: 50 }));
      await vi.advanceTimersByTimeAsync(200);
      const result = await promise;

      expect(result.startedAt.getTime()).toBeLessThanOrEqual(result.finishedAt.getTime());
      expect(result.startedAt.getTime()).toBeLessThanOrEqual(beforeStart.getTime() + 50);
    });

    it('behaves identically to no-retry when maxRetries is 0', async () => {
      execaMock.mockRejectedValueOnce(new Error('single failure'));

      const result = await runner.execute(makeAutomation({ maxRetries: 0 }));

      expect(result.success).toBe(false);
      expect(result.error).toBe('single failure');
      expect(result.attemptNumber).toBe(1);
      expect(result.totalAttempts).toBe(1);
      expect(execaMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop signal in shell mode', () => {
    it('passes cancelSignal to execa and stops before the next step', async () => {
      const controller = new AbortController();
      execaMock.mockImplementationOnce(async () => {
        controller.abort(); // user hits Stop while step 1 runs
        return { exitCode: undefined, stdout: '', stderr: '' };
      });

      const result = await runner.execute(
        makeAutomation({ instructions: 'echo one\necho two' }),
        undefined, undefined, undefined, controller.signal,
      );

      expect(execaMock).toHaveBeenCalledTimes(1);
      expect(execaMock.mock.calls[0][2].cancelSignal).toBe(controller.signal);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Run stopped by user');
    });
  });

  describe('claude mode CLI invocation', () => {
    it('pipes prompt via stdin, not --prompt-file', async () => {
      // Mock execa to return an async iterable (stream-json lines) then resolve
      const resultEvent = JSON.stringify({ type: 'result', result: 'hello world', total_cost_usd: 0.001 });
      const mockProc = {
        [Symbol.asyncIterator]: async function* () { yield resultEvent; },
        then: (resolve: (v: unknown) => void) => resolve({ exitCode: 0, stdout: resultEvent, stderr: '' }),
      };
      execaMock.mockReturnValueOnce(mockProc);

      const result = await runner.execute(makeAutomation({
        mode: 'claude',
        instructions: '# Say hello',
      }));

      expect(result.success).toBe(true);

      // Verify execa was called with 'claude' and stdin input
      const call = execaMock.mock.calls[0];
      expect(call[0]).toBe('claude');

      const args: string[] = call[1];
      expect(args).toContain('--print');
      expect(args).not.toContain('--prompt-file');

      const opts = call[2];
      expect(opts.input).toBe('test prompt content');
    });

    it('does not pass --prompt-file in sandbox mode either', async () => {
      const sandboxRunner = new Runner(undefined, true, { notify: notifyMock } as unknown as Notifier);

      const resultEvent = JSON.stringify({ type: 'result', result: 'sandbox hello', total_cost_usd: 0.001 });
      const mockProc = {
        [Symbol.asyncIterator]: async function* () { yield resultEvent; },
        then: (resolve: (v: unknown) => void) => resolve({ exitCode: 0, stdout: resultEvent, stderr: '' }),
      };
      execaMock.mockReturnValueOnce(mockProc);

      const result = await sandboxRunner.execute(makeAutomation({
        mode: 'claude',
        sandbox: true,
        instructions: '# Say hello in sandbox',
      }));

      expect(result.success).toBe(true);

      const call = execaMock.mock.calls[0];
      // In sandbox mode, cmd is 'docker' and the claude command is embedded
      expect(call[0]).toBe('docker');

      const dockerArgs: string[] = call[1];
      const fullCmd = dockerArgs.join(' ');
      expect(fullCmd).not.toContain('--prompt-file');
      expect(fullCmd).toContain('cat /tmp/prompt.txt');
    });
  });
});
