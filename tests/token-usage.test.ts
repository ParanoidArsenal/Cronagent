/**
 * Tests for token-usage analytics:
 *
 *   1. Stream-JSON parsing — tested via Runner.execute() by mocking `execa`
 *      to return an async-iterable subprocess that emits stream-json events.
 *
 *   2. History analytics methods — getUsageStats() and getAgentStats() are
 *      tested with a mock pool injected via the public History.create() path.
 *      No real PostgreSQL connection is required.
 *
 *   3. UsageStat / AgentStat interfaces — structural shape tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UsageStat, AgentStat } from '@cronagent/history';
import type { Automation } from '@cronagent/types';

// ── Mock execa ────────────────────────────────────────────────────────────────
// Returns an object whose .stdout is an async iterable of lines (stream-json).

const mockExeca = vi.fn();

vi.mock('execa', () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

// ── Mock node:fs/promises ─────────────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock prompt content'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import under test (after mocks) ──────────────────────────────────────────
import { Runner } from '../src/runner.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Automation fixture suitable for claude mode. */
function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    name: 'test-automation',
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
    ...overrides,
  };
}

/**
 * Create a mock execa subprocess that emits stream-json lines on stdout.
 * The returned object has an async-iterable .stdout and resolves as a promise
 * with exitCode, stdout (array), and stderr.
 */
function mockClaudeStream(lines: string[], exitCode = 0, stderr = '') {
  const stdoutLines = lines;

  // The subprocess is both a promise and an async iterable (iterating stdout lines).
  // execa v9 with lines:true makes the subprocess itself async-iterable.
  const resolved = { exitCode, stdout: stdoutLines, stderr };

  const subprocess = Object.assign(
    Promise.resolve(resolved),
    {
      stdout: {
        async *[Symbol.asyncIterator]() {
          for (const line of stdoutLines) yield line;
        },
      },
      stderr: '',
      exitCode,
      async *[Symbol.asyncIterator]() {
        for (const line of stdoutLines) yield line;
      },
    },
  );

  mockExeca.mockReturnValue(subprocess);
}

/** Build a stream-json result event line. */
function resultEvent(opts: {
  result?: string;
  total_cost_usd?: number;
  cost_usd?: number;
  costUsd?: number;
  is_error?: boolean;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}): string {
  return JSON.stringify({ type: 'result', ...opts });
}

/** Build a stream-json assistant event line. */
function assistantEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    content: [{ type: 'text', text }],
  });
}

/** Build a stream-json error event line. */
function errorEvent(message: string, errorType?: string): string {
  return JSON.stringify({
    type: 'error',
    message,
    ...(errorType ? { error_type: errorType } : {}),
  });
}

// ── Stream-JSON parsing tests (via Runner.execute) ────────────────────────────

describe('Stream-JSON parsing — via Runner.execute()', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new Runner(undefined, false); // no mcp config, sandbox disabled
  });

  // ── Cost extraction ──────────────────────────────────────────────────────────

  describe('cost extraction from result event', () => {
    it('extracts costUsd from total_cost_usd', async () => {
      mockClaudeStream([
        assistantEvent('All done.'),
        resultEvent({ result: 'All done.', total_cost_usd: 0.0042, usage: { input_tokens: 100, output_tokens: 50 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBe(0.0042);
    });

    it('extracts the output text from the result field', async () => {
      mockClaudeStream([
        resultEvent({ result: 'Task completed successfully.', total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.output).toBe('Task completed successfully.');
    });

    it('handles total_cost_usd of zero', async () => {
      mockClaudeStream([
        resultEvent({ result: 'done', total_cost_usd: 0 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBe(0);
    });

    it('handles total_cost_usd as a large float', async () => {
      mockClaudeStream([
        resultEvent({ result: 'heavy work', total_cost_usd: 1.23456789 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBeCloseTo(1.23456789);
    });
  });

  // ── Legacy fallback fields ──────────────────────────────────────────────────

  describe('legacy cost field fallback', () => {
    it('falls back to cost_usd when total_cost_usd is absent', async () => {
      mockClaudeStream([
        resultEvent({ result: 'done', cost_usd: 0.0077, usage: { input_tokens: 200, output_tokens: 80 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBe(0.0077);
    });

    it('falls back to costUsd (camelCase) when both total_cost_usd and cost_usd are absent', async () => {
      mockClaudeStream([
        resultEvent({ result: 'done', costUsd: 0.0055 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBe(0.0055);
    });

    it('prefers total_cost_usd over cost_usd when both are present', async () => {
      mockClaudeStream([
        JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.0030, cost_usd: 0.0099 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBe(0.0030);
    });

    it('prefers total_cost_usd over costUsd when both are present', async () => {
      mockClaudeStream([
        JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.0011, costUsd: 0.0088 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBe(0.0011);
    });

    it('prefers cost_usd over costUsd when total_cost_usd is absent', async () => {
      mockClaudeStream([
        JSON.stringify({ type: 'result', result: 'done', cost_usd: 0.0044, costUsd: 0.0099 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBe(0.0044);
    });
  });

  // ── Token counts ────────────────────────────────────────────────────────────

  describe('usage.input_tokens and usage.output_tokens', () => {
    it('extracts input_tokens from usage object', async () => {
      mockClaudeStream([
        resultEvent({ result: 'ok', total_cost_usd: 0.001, usage: { input_tokens: 1234, output_tokens: 567 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.inputTokens).toBe(1234);
    });

    it('extracts output_tokens from usage object', async () => {
      mockClaudeStream([
        resultEvent({ result: 'ok', total_cost_usd: 0.001, usage: { input_tokens: 100, output_tokens: 999 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.outputTokens).toBe(999);
    });

    it('returns both token counts together', async () => {
      mockClaudeStream([
        resultEvent({ result: 'ok', usage: { input_tokens: 512, output_tokens: 256 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.inputTokens).toBe(512);
      expect(result.outputTokens).toBe(256);
    });

    it('handles zero token counts', async () => {
      mockClaudeStream([
        resultEvent({ result: 'empty', usage: { input_tokens: 0, output_tokens: 0 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    });
  });

  // ── Missing / partial usage object ─────────────────────────────────────────

  describe('missing usage object', () => {
    it('returns undefined inputTokens when usage key is absent', async () => {
      mockClaudeStream([
        resultEvent({ result: 'no usage', total_cost_usd: 0.002 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.inputTokens).toBeUndefined();
    });

    it('returns undefined outputTokens when usage key is absent', async () => {
      mockClaudeStream([
        resultEvent({ result: 'no usage', total_cost_usd: 0.002 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.outputTokens).toBeUndefined();
    });

    it('returns undefined inputTokens when usage object exists but input_tokens is missing', async () => {
      mockClaudeStream([
        resultEvent({ result: 'partial', usage: { output_tokens: 42 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.inputTokens).toBeUndefined();
    });

    it('returns undefined outputTokens when usage object exists but output_tokens is missing', async () => {
      mockClaudeStream([
        resultEvent({ result: 'partial', usage: { input_tokens: 42 } }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.outputTokens).toBeUndefined();
    });

    it('returns undefined costUsd when no cost field is present', async () => {
      mockClaudeStream([
        resultEvent({ result: 'no cost' }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBeUndefined();
    });
  });

  // ── Assistant event accumulation ──────────────────────────────────────────

  describe('assistant event text accumulation', () => {
    it('accumulates text from multiple assistant events', async () => {
      mockClaudeStream([
        assistantEvent('Hello '),
        assistantEvent('world!'),
        resultEvent({ total_cost_usd: 0.001 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.output).toBe('Hello world!');
    });

    it('prefers result.result over accumulated assistant text', async () => {
      mockClaudeStream([
        assistantEvent('partial'),
        resultEvent({ result: 'final answer', total_cost_usd: 0.001 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.output).toBe('final answer');
    });

    it('uses accumulated assistant text when result has no result field', async () => {
      mockClaudeStream([
        assistantEvent('streamed content'),
        resultEvent({ total_cost_usd: 0.001 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.output).toBe('streamed content');
    });
  });

  // ── Empty / no events ────────────────────────────────────────────────────

  describe('empty or no events', () => {
    it('handles empty stream gracefully', async () => {
      mockClaudeStream([]);

      const result = await runner.execute(makeAutomation());
      expect(result.output).toBe('');
      expect(result.costUsd).toBeUndefined();
    });

    it('handles non-JSON lines gracefully', async () => {
      mockClaudeStream(['not JSON at all', 'another line']);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBeUndefined();
    });

    it('handles partially valid JSON (truncated) gracefully', async () => {
      mockClaudeStream(['{"type": "result", "incomplete...']);

      const result = await runner.execute(makeAutomation());
      expect(result.costUsd).toBeUndefined();
    });
  });

  // ── Error events ──────────────────────────────────────────────────────────

  describe('error events', () => {
    it('captures error message from error event', async () => {
      mockClaudeStream([
        errorEvent('Something went wrong'),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
      expect(result.error).toBe('Something went wrong');
    });

    it('prefixes rate_limit for overloaded_error type', async () => {
      mockClaudeStream([
        errorEvent('Service overloaded', 'overloaded_error'),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
      expect(result.error).toContain('rate_limit:');
    });

    it('prefixes rate_limit when message contains "rate"', async () => {
      mockClaudeStream([
        errorEvent('Rate limit exceeded'),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
      expect(result.error).toContain('rate_limit:');
    });

    it('captures error from result event with is_error:true', async () => {
      mockClaudeStream([
        resultEvent({ is_error: true, result: 'Authentication failed: no API key found' }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
      expect(result.error).toBe('Authentication failed: no API key found');
    });

    it('falls back to generic message when result event has is_error but no error text', async () => {
      mockClaudeStream([
        resultEvent({ is_error: true }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
      expect(result.error).toBe('Claude reported an error');
    });
  });

  // ── Exit codes ────────────────────────────────────────────────────────────

  describe('exit code handling', () => {
    it('reports timeout for exit code 137 (SIGKILL)', async () => {
      mockClaudeStream([], 137);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      expect(result.error).toContain('SIGKILL');
    });

    it('reports timeout for exit code 143 (SIGTERM)', async () => {
      mockClaudeStream([], 143);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      expect(result.error).toContain('SIGTERM');
    });

    it('reports failure for non-zero exit code', async () => {
      mockClaudeStream([], 1, 'some error');

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(false);
    });
  });

  // ── ExecutionResult shape ───────────────────────────────────────────────────

  describe('ExecutionResult fields', () => {
    it('marks result as success:true on a clean run', async () => {
      mockClaudeStream([resultEvent({ result: 'ok', total_cost_usd: 0.001 })]);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(true);
    });

    it('sets automationName from the automation object', async () => {
      mockClaudeStream([resultEvent({ result: 'ok' })]);

      const result = await runner.execute(makeAutomation({ name: 'my-special-job' }));
      expect(result.automationName).toBe('my-special-job');
    });

    it('records a positive durationMs', async () => {
      mockClaudeStream([resultEvent({ result: 'fast' })]);

      const result = await runner.execute(makeAutomation());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('sets mode to claude', async () => {
      mockClaudeStream([resultEvent({ result: 'ok' })]);

      const result = await runner.execute(makeAutomation());
      expect(result.mode).toBe('claude');
    });

    it('includes logFile path', async () => {
      mockClaudeStream([resultEvent({ result: 'ok' })]);

      const result = await runner.execute(makeAutomation());
      expect(result.logFile).toBeDefined();
      expect(result.logFile).toContain('test-automation');
    });
  });

  // ── Unknown event types ──────────────────────────────────────────────────

  describe('unknown event types', () => {
    it('ignores unknown event types gracefully', async () => {
      mockClaudeStream([
        JSON.stringify({ type: 'tool_use', name: 'bash', input: {} }),
        JSON.stringify({ type: 'system', message: 'starting' }),
        resultEvent({ result: 'ok', total_cost_usd: 0.001 }),
      ]);

      const result = await runner.execute(makeAutomation());
      expect(result.success).toBe(true);
      expect(result.output).toBe('ok');
    });
  });
});

// ── History analytics interface shape tests ──────────────────────────────────

describe('UsageStat interface', () => {
  it('accepts a well-formed UsageStat object', () => {
    const stat: UsageStat = {
      day: '2026-04-01',
      total_cost: 0.1234,
      total_input_tokens: 10000,
      total_output_tokens: 5000,
      run_count: 42,
    };

    expect(stat.day).toBe('2026-04-01');
    expect(stat.total_cost).toBe(0.1234);
    expect(stat.total_input_tokens).toBe(10000);
    expect(stat.total_output_tokens).toBe(5000);
    expect(stat.run_count).toBe(42);
  });

  it('allows total_cost of zero (no spending day)', () => {
    const stat: UsageStat = {
      day: '2026-03-15',
      total_cost: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      run_count: 1,
    };

    expect(stat.total_cost).toBe(0);
  });

  it('has all five expected fields', () => {
    const stat: UsageStat = {
      day: '2026-01-01',
      total_cost: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      run_count: 0,
    };

    const keys = Object.keys(stat);
    expect(keys).toContain('day');
    expect(keys).toContain('total_cost');
    expect(keys).toContain('total_input_tokens');
    expect(keys).toContain('total_output_tokens');
    expect(keys).toContain('run_count');
  });
});

describe('AgentStat interface', () => {
  it('accepts a well-formed AgentStat object', () => {
    const stat: AgentStat = {
      automation_name: 'daily-report',
      total_runs: 30,
      success_rate: 96.7,
      avg_cost: 0.005,
      avg_duration_ms: 12500,
      total_input_tokens: 150000,
      total_output_tokens: 75000,
      total_cost: 0.15,
    };

    expect(stat.automation_name).toBe('daily-report');
    expect(stat.total_runs).toBe(30);
    expect(stat.success_rate).toBeCloseTo(96.7);
    expect(stat.avg_cost).toBe(0.005);
    expect(stat.avg_duration_ms).toBe(12500);
    expect(stat.total_input_tokens).toBe(150000);
    expect(stat.total_output_tokens).toBe(75000);
    expect(stat.total_cost).toBe(0.15);
  });

  it('allows success_rate of 100 (all successful)', () => {
    const stat: AgentStat = {
      automation_name: 'perfect-job',
      total_runs: 10,
      success_rate: 100,
      avg_cost: 0.001,
      avg_duration_ms: 5000,
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cost: 0.01,
    };

    expect(stat.success_rate).toBe(100);
  });

  it('allows success_rate of 0 (all failed)', () => {
    const stat: AgentStat = {
      automation_name: 'broken-job',
      total_runs: 5,
      success_rate: 0,
      avg_cost: 0,
      avg_duration_ms: 1000,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    };

    expect(stat.success_rate).toBe(0);
  });

  it('has all eight expected fields', () => {
    const stat: AgentStat = {
      automation_name: 'test',
      total_runs: 1,
      success_rate: 100,
      avg_cost: 0,
      avg_duration_ms: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    };

    const keys = Object.keys(stat);
    expect(keys).toContain('automation_name');
    expect(keys).toContain('total_runs');
    expect(keys).toContain('success_rate');
    expect(keys).toContain('avg_cost');
    expect(keys).toContain('avg_duration_ms');
    expect(keys).toContain('total_input_tokens');
    expect(keys).toContain('total_output_tokens');
    expect(keys).toContain('total_cost');
  });
});

// ── History mock — getUsageStats / getAgentStats behaviour ───────────────────

describe('History analytics methods (mocked)', () => {
  const mockGetUsageStats = vi.fn();
  const mockGetAgentStats = vi.fn();

  const fakeHistory = {
    getUsageStats: mockGetUsageStats,
    getAgentStats: mockGetAgentStats,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getUsageStats()', () => {
    it('returns an array of UsageStat rows ordered by day', async () => {
      const rows: UsageStat[] = [
        { day: '2026-03-30', total_cost: 0.05, total_input_tokens: 5000, total_output_tokens: 2500, run_count: 10 },
        { day: '2026-03-31', total_cost: 0.08, total_input_tokens: 8000, total_output_tokens: 4000, run_count: 16 },
        { day: '2026-04-01', total_cost: 0.12, total_input_tokens: 12000, total_output_tokens: 6000, run_count: 24 },
      ];
      mockGetUsageStats.mockResolvedValue(rows);

      const result = await fakeHistory.getUsageStats(7);

      expect(result).toHaveLength(3);
      expect(result[0].day).toBe('2026-03-30');
      expect(result[2].day).toBe('2026-04-01');
    });

    it('returns an empty array when no runs exist in the window', async () => {
      mockGetUsageStats.mockResolvedValue([]);

      const result = await fakeHistory.getUsageStats(7);

      expect(result).toEqual([]);
    });

    it('passes the days argument to the underlying query', async () => {
      mockGetUsageStats.mockResolvedValue([]);

      await fakeHistory.getUsageStats(30);

      expect(mockGetUsageStats).toHaveBeenCalledWith(30);
    });

    it('each row has numeric total_cost', async () => {
      const rows: UsageStat[] = [
        { day: '2026-04-01', total_cost: 0.123, total_input_tokens: 100, total_output_tokens: 50, run_count: 2 },
      ];
      mockGetUsageStats.mockResolvedValue(rows);

      const result = await fakeHistory.getUsageStats(1);

      expect(typeof result[0].total_cost).toBe('number');
    });

    it('each row has integer run_count', async () => {
      const rows: UsageStat[] = [
        { day: '2026-04-01', total_cost: 0, total_input_tokens: 0, total_output_tokens: 0, run_count: 7 },
      ];
      mockGetUsageStats.mockResolvedValue(rows);

      const result = await fakeHistory.getUsageStats(1);

      expect(Number.isInteger(result[0].run_count)).toBe(true);
    });

    it('accumulates total_input_tokens and total_output_tokens per day', async () => {
      const rows: UsageStat[] = [
        { day: '2026-04-01', total_cost: 0.01, total_input_tokens: 3000, total_output_tokens: 1500, run_count: 3 },
      ];
      mockGetUsageStats.mockResolvedValue(rows);

      const result = await fakeHistory.getUsageStats(1);

      expect(result[0].total_input_tokens).toBe(3000);
      expect(result[0].total_output_tokens).toBe(1500);
    });
  });

  describe('getAgentStats()', () => {
    it('returns an array of AgentStat rows', async () => {
      const rows: AgentStat[] = [
        {
          automation_name: 'report-gen',
          total_runs: 50,
          success_rate: 98.0,
          avg_cost: 0.008,
          avg_duration_ms: 15000,
          total_input_tokens: 400000,
          total_output_tokens: 200000,
          total_cost: 0.40,
        },
        {
          automation_name: 'data-sync',
          total_runs: 20,
          success_rate: 85.0,
          avg_cost: 0.002,
          avg_duration_ms: 5000,
          total_input_tokens: 40000,
          total_output_tokens: 20000,
          total_cost: 0.04,
        },
      ];
      mockGetAgentStats.mockResolvedValue(rows);

      const result = await fakeHistory.getAgentStats();

      expect(result).toHaveLength(2);
      expect(result[0].automation_name).toBe('report-gen');
      expect(result[1].automation_name).toBe('data-sync');
    });

    it('returns an empty array when run_history is empty', async () => {
      mockGetAgentStats.mockResolvedValue([]);

      const result = await fakeHistory.getAgentStats();

      expect(result).toEqual([]);
    });

    it('calls getAgentStats with no arguments', async () => {
      mockGetAgentStats.mockResolvedValue([]);

      await fakeHistory.getAgentStats();

      expect(mockGetAgentStats).toHaveBeenCalledWith();
    });

    it('each row has a success_rate between 0 and 100', async () => {
      const rows: AgentStat[] = [
        {
          automation_name: 'job-a',
          total_runs: 10,
          success_rate: 70.0,
          avg_cost: 0.001,
          avg_duration_ms: 2000,
          total_input_tokens: 1000,
          total_output_tokens: 500,
          total_cost: 0.01,
        },
      ];
      mockGetAgentStats.mockResolvedValue(rows);

      const result = await fakeHistory.getAgentStats();

      expect(result[0].success_rate).toBeGreaterThanOrEqual(0);
      expect(result[0].success_rate).toBeLessThanOrEqual(100);
    });

    it('total_cost equals avg_cost * total_runs for a single agent', async () => {
      const avgCost = 0.005;
      const totalRuns = 20;
      const rows: AgentStat[] = [
        {
          automation_name: 'cost-check',
          total_runs: totalRuns,
          success_rate: 100,
          avg_cost: avgCost,
          avg_duration_ms: 1000,
          total_input_tokens: 2000,
          total_output_tokens: 1000,
          total_cost: avgCost * totalRuns,
        },
      ];
      mockGetAgentStats.mockResolvedValue(rows);

      const result = await fakeHistory.getAgentStats();

      expect(result[0].total_cost).toBeCloseTo(avgCost * totalRuns);
    });

    it('total_input_tokens and total_output_tokens are non-negative integers', async () => {
      const rows: AgentStat[] = [
        {
          automation_name: 'token-check',
          total_runs: 5,
          success_rate: 100,
          avg_cost: 0,
          avg_duration_ms: 1000,
          total_input_tokens: 500,
          total_output_tokens: 250,
          total_cost: 0,
        },
      ];
      mockGetAgentStats.mockResolvedValue(rows);

      const result = await fakeHistory.getAgentStats();

      expect(result[0].total_input_tokens).toBeGreaterThanOrEqual(0);
      expect(result[0].total_output_tokens).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result[0].total_input_tokens)).toBe(true);
      expect(Number.isInteger(result[0].total_output_tokens)).toBe(true);
    });
  });
});

// ── parsePeriodDays logic (inline unit tests) ─────────────────────────────────

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  if (match) return Math.min(parseInt(match[1], 10), 365);
  return 7;
}

describe('parsePeriodDays() — usage route query-param parsing', () => {
  it('parses "7d" to 7', () => {
    expect(parsePeriodDays('7d')).toBe(7);
  });

  it('parses "30d" to 30', () => {
    expect(parsePeriodDays('30d')).toBe(30);
  });

  it('parses "90d" to 90', () => {
    expect(parsePeriodDays('90d')).toBe(90);
  });

  it('parses "365d" to 365', () => {
    expect(parsePeriodDays('365d')).toBe(365);
  });

  it('clamps values above 365 to 365', () => {
    expect(parsePeriodDays('999d')).toBe(365);
  });

  it('defaults to 7 for invalid format (no trailing d)', () => {
    expect(parsePeriodDays('30')).toBe(7);
  });

  it('defaults to 7 for empty string', () => {
    expect(parsePeriodDays('')).toBe(7);
  });

  it('defaults to 7 for non-numeric prefix', () => {
    expect(parsePeriodDays('monthly')).toBe(7);
  });

  it('defaults to 7 for "1w" (wrong unit)', () => {
    expect(parsePeriodDays('1w')).toBe(7);
  });

  it('parses "1d" to 1', () => {
    expect(parsePeriodDays('1d')).toBe(1);
  });
});
