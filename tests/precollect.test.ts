/**
 * Tests for preCollect feature — verifies the runner executes a shell command
 * before invoking Claude and appends its stdout to the prompt under a
 * "Pre-collected data" header.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Automation } from '@cronagent/types';

// ── Track execa calls (must distinguish preCollect from Claude) ──────────────

const mockExeca = vi.fn();

vi.mock('execa', () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

// ── Mock node:fs/promises ────────────────────────────────────────────────────

const mockReadFile = vi.fn().mockResolvedValue('mock prompt content');
const mockWriteFile = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
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
    instructions: 'Original prompt body.',
    filePath: '/tmp/test.md',
    mode: 'claude',
    sandbox: false,
    ...overrides,
  };
}

function resultEvent(result = 'done'): string {
  return JSON.stringify({
    type: 'result',
    is_error: false,
    result,
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

function makeClaudeSubprocess(lines: string[], exitCode = 0) {
  const resolved = { exitCode, stdout: lines, stderr: '' };
  return Object.assign(Promise.resolve(resolved), {
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (const line of lines) yield line;
      },
    },
    stderr: '',
    exitCode,
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line;
    },
  });
}

/**
 * Set up execa mock that distinguishes preCollect (bash -c) from Claude.
 * preCollect returns a plain promise; Claude returns a streaming subprocess.
 */
function mockExecaSplit(preCollectStdout: string) {
  mockExeca.mockImplementation((cmd: string, _args: string[]) => {
    if (cmd === 'bash') {
      return Promise.resolve({ exitCode: 0, stdout: preCollectStdout, stderr: '' });
    }
    return makeClaudeSubprocess([resultEvent()]);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('preCollect', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue('mock prompt content');
    runner = new Runner(undefined, false);
  });

  it('does NOT invoke bash when preCollect is not set', async () => {
    mockExecaSplit('');
    await runner.execute(makeAutomation());

    const bashCalls = mockExeca.mock.calls.filter((c) => c[0] === 'bash');
    expect(bashCalls).toHaveLength(0);
  });

  it('invokes bash with the preCollect command via -c', async () => {
    mockExecaSplit('git data here');
    await runner.execute(makeAutomation({ preCollect: 'echo hello && git log' }));

    const bashCalls = mockExeca.mock.calls.filter((c) => c[0] === 'bash');
    expect(bashCalls).toHaveLength(1);
    expect(bashCalls[0][1]).toEqual(['-c', 'echo hello && git log']);
  });

  it('appends preCollect stdout to the prompt under a "Pre-collected data" header', async () => {
    const collected = 'date_range: yesterday\nsince_date: 2026-04-05\njql: assignee = me';
    mockExecaSplit(collected);

    await runner.execute(
      makeAutomation({
        instructions: 'Original prompt body.',
        preCollect: 'bash scripts/collect.sh',
      }),
    );

    // The runner writes full instructions to a temp file before invoking Claude.
    // Find that write call (the .md temp file).
    const tmpWrite = mockWriteFile.mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith('.md'),
    );
    expect(tmpWrite).toBeDefined();
    const written = String(tmpWrite![1]);

    expect(written).toContain('Original prompt body.');
    expect(written).toContain('## Pre-collected data');
    expect(written).toContain(collected);
  });

  it('does NOT add the "Pre-collected data" header when preCollect is empty', async () => {
    mockExecaSplit('');
    await runner.execute(
      makeAutomation({
        instructions: 'Original prompt.',
        preCollect: 'true', // runs but produces no stdout
      }),
    );

    const tmpWrite = mockWriteFile.mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith('.md'),
    );
    const written = String(tmpWrite![1]);
    expect(written).toBe('Original prompt.');
    expect(written).not.toContain('Pre-collected data');
  });

  it('does NOT add the header when preCollect field is undefined', async () => {
    mockExecaSplit('');
    await runner.execute(makeAutomation({ instructions: 'Just the prompt.' }));

    const tmpWrite = mockWriteFile.mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith('.md'),
    );
    const written = String(tmpWrite![1]);
    expect(written).toBe('Just the prompt.');
    expect(written).not.toContain('Pre-collected data');
  });

  it('continues with Claude execution even when preCollect throws', async () => {
    mockExeca.mockImplementation((cmd: string) => {
      if (cmd === 'bash') {
        return Promise.reject(new Error('preCollect failed'));
      }
      return makeClaudeSubprocess([resultEvent()]);
    });

    const result = await runner.execute(
      makeAutomation({ preCollect: 'exit 1' }),
    );

    // Claude should still have been called
    const claudeCalls = mockExeca.mock.calls.filter((c) => c[0] === 'claude');
    expect(claudeCalls.length).toBeGreaterThan(0);
    expect(result.success).toBe(true);
  });

  it('passes the env to the preCollect bash invocation', async () => {
    mockExecaSplit('output');
    await runner.execute(
      makeAutomation({ preCollect: 'echo $FOO' }),
      { FOO: 'bar' },
    );

    const bashCall = mockExeca.mock.calls.find((c) => c[0] === 'bash');
    expect(bashCall).toBeDefined();
    const opts = bashCall![2] as Record<string, unknown>;
    expect(opts.env).toBeDefined();
    const env = opts.env as Record<string, string>;
    expect(env.FOO).toBe('bar');
  });

  it('preCollect runs BEFORE the claude subprocess', async () => {
    const callOrder: string[] = [];
    mockExeca.mockImplementation((cmd: string) => {
      callOrder.push(cmd);
      if (cmd === 'bash') {
        return Promise.resolve({ exitCode: 0, stdout: 'pre data', stderr: '' });
      }
      return makeClaudeSubprocess([resultEvent()]);
    });

    await runner.execute(
      makeAutomation({ preCollect: 'echo data' }),
    );

    expect(callOrder[0]).toBe('bash');
    expect(callOrder[1]).toBe('claude');
  });
});
