/**
 * Tests for Claude CLI invocation — verifies correct flags, Docker args,
 * MCP config resolution, and sandbox isolation settings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Automation } from '@cronagent/types';

// ── Track execa calls ────────────────────────────────────────────────────────

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
    instructions: 'Do the thing.',
    filePath: '/tmp/test.md',
    mode: 'claude',
    sandbox: false,
    ...overrides,
  };
}

function resultEvent(result = 'done', cost = 0.001): string {
  return JSON.stringify({
    type: 'result',
    is_error: false,
    result,
    total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

function mockClaudeStream(lines: string[], exitCode = 0, stderr = '') {
  const resolved = { exitCode, stdout: lines, stderr };
  const subprocess = Object.assign(Promise.resolve(resolved), {
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
  mockExeca.mockReturnValue(subprocess);
}

/** Get the args from the most recent execa call. */
function getExecaCall(): { cmd: string; args: string[]; opts: Record<string, unknown> } {
  const call = mockExeca.mock.calls[mockExeca.mock.calls.length - 1];
  return { cmd: call[0], args: call[1], opts: call[2] ?? {} };
}

/** For sandbox mode, extract the claude command string from docker args. */
function getClaudeCmdFromDockerArgs(args: string[]): string {
  // The last arg is the command string passed to bash -c
  return args[args.length - 1];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Claude CLI invocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue('mock prompt content');
  });

  // ── Non-sandbox CLI flags ──────────────────────────────────────────────────

  describe('non-sandbox mode', () => {
    let runner: Runner;

    beforeEach(() => {
      runner = new Runner(undefined, false); // no MCP, sandbox disabled
      mockClaudeStream([resultEvent()]);
    });

    it('passes --print flag', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      expect(args).toContain('--print');
    });

    it('passes --verbose flag', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      expect(args).toContain('--verbose');
    });

    it('passes --output-format stream-json', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      const idx = args.indexOf('--output-format');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('stream-json');
    });

    it('passes --dangerously-skip-permissions', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('passes --effort max', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      const idx = args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('max');
    });

    it('passes --model from automation config', async () => {
      await runner.execute(makeAutomation({ model: 'opus' }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('opus');
    });

    it('passes --max-turns 10', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      const idx = args.indexOf('--max-turns');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('10');
    });

    it('runs claude command directly (not docker)', async () => {
      await runner.execute(makeAutomation());
      const { cmd } = getExecaCall();
      expect(cmd).toBe('claude');
    });

    it('pipes prompt content via stdin', async () => {
      await runner.execute(makeAutomation());
      const { opts } = getExecaCall();
      expect(opts.input).toBe('mock prompt content');
    });

    it('sets lines:true for NDJSON parsing', async () => {
      await runner.execute(makeAutomation());
      const { opts } = getExecaCall();
      expect(opts.lines).toBe(true);
    });

    it('sets reject:false to handle errors manually', async () => {
      await runner.execute(makeAutomation());
      const { opts } = getExecaCall();
      expect(opts.reject).toBe(false);
    });

    it('does not pass --mcp-config when no MCP configured', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      expect(args).not.toContain('--mcp-config');
    });

    it('does not pass --append-system-prompt when systemPrompt is not set', async () => {
      await runner.execute(makeAutomation());
      const { args } = getExecaCall();
      expect(args).not.toContain('--append-system-prompt');
    });

    it('passes --append-system-prompt with systemPrompt content when configured', async () => {
      const sysPrompt = 'Available MCP tools: mcp__jira__jira_search, mcp__gitlab__list_my_merge_requests';
      await runner.execute(makeAutomation({ systemPrompt: sysPrompt }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--append-system-prompt');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(sysPrompt);
    });
  });

  // ── Non-sandbox with MCP ───────────────────────────────────────────────────

  describe('non-sandbox with MCP config', () => {
    let runner: Runner;

    beforeEach(() => {
      runner = new Runner('/app/mcp.json', false);
      mockClaudeStream([resultEvent()]);
      // Mock readFile to return MCP config when reading the config path
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('mcp')) {
          return Promise.resolve(JSON.stringify({
            mcpServers: {
              gitlab: {
                command: 'node',
                args: ['mcp-servers/gitlab/dist/index.js'],
                env: { GITLAB_URL: '${GITLAB_URL}' },
              },
            },
          }));
        }
        return Promise.resolve('mock prompt content');
      });
    });

    it('passes --mcp-config pointing to resolved temp file', async () => {
      await runner.execute(makeAutomation({ mcp: ['gitlab'] }));
      const { args } = getExecaCall();
      expect(args).toContain('--mcp-config');
      const idx = args.indexOf('--mcp-config');
      // Should be a temp file path, not the original
      expect(args[idx + 1]).toMatch(/\/tmp\/.*mcp.*\.json/);
      expect(args[idx + 1]).not.toBe('/app/mcp.json');
    });

    it('resolves ${VAR} placeholders in MCP config', async () => {
      await runner.execute(
        makeAutomation({ mcp: ['gitlab'] }),
        { GITLAB_URL: 'https://gitlab.example.com' },
      );
      // Check what was written to the temp file
      const writeCall = mockWriteFile.mock.calls.find(
        (c: unknown[]) => String(c[0]).includes('mcp'),
      );
      expect(writeCall).toBeDefined();
      const written = writeCall![1] as string;
      expect(written).toContain('https://gitlab.example.com');
      expect(written).not.toContain('${GITLAB_URL}');
    });

    it('resolves relative .js paths to absolute in MCP config', async () => {
      await runner.execute(makeAutomation({ mcp: ['gitlab'] }));
      const writeCall = mockWriteFile.mock.calls.find(
        (c: unknown[]) => String(c[0]).includes('mcp'),
      );
      expect(writeCall).toBeDefined();
      const written = writeCall![1] as string;
      const config = JSON.parse(written);
      const gitlabArgs = config.mcpServers.gitlab.args[0];
      // Should be absolute, not relative
      expect(gitlabArgs).toMatch(/^\/.*mcp-servers\/gitlab\/dist\/index\.js$/);
      expect(gitlabArgs).not.toBe('mcp-servers/gitlab/dist/index.js');
    });
  });

  // ── Sandbox mode Docker args ───────────────────────────────────────────────

  describe('sandbox mode', () => {
    let runner: Runner;

    beforeEach(() => {
      runner = new Runner(undefined, true); // sandbox enabled
      mockClaudeStream([resultEvent()]);
    });

    it('runs via docker command', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { cmd } = getExecaCall();
      expect(cmd).toBe('docker');
    });

    it('uses docker run --rm', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      expect(args[0]).toBe('run');
      expect(args).toContain('--rm');
    });

    it('sets --network host for API access', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--network');
      expect(args[idx + 1]).toBe('host');
    });

    it('limits memory to 1g', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--memory');
      expect(args[idx + 1]).toBe('1g');
    });

    it('limits to 1 CPU', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--cpus');
      expect(args[idx + 1]).toBe('1');
    });

    it('sets pids limit to 256', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--pids-limit');
      expect(args[idx + 1]).toBe('256');
    });

    it('uses read-only filesystem', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      expect(args).toContain('--read-only');
    });

    it('provides writable /tmp tmpfs (256m, no exec restriction)', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const tmpfsArgs = args.filter((_: string, i: number) => args[i - 1] === '--tmpfs');
      const tmpEntry = tmpfsArgs.find((a: string) => a.startsWith('/tmp:'));
      expect(tmpEntry).toBeDefined();
      expect(tmpEntry).toContain('size=256m');
      expect(tmpEntry).not.toContain('noexec');
    });

    it('provides writable /workspace tmpfs', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const tmpfsArgs = args.filter((_: string, i: number) => args[i - 1] === '--tmpfs');
      expect(tmpfsArgs.some((a: string) => a.startsWith('/workspace:'))).toBe(true);
    });

    it('provides writable /home/sandbox/.claude tmpfs for Claude config', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const tmpfsArgs = args.filter((_: string, i: number) => args[i - 1] === '--tmpfs');
      expect(tmpfsArgs.some((a: string) => a.startsWith('/home/sandbox/.claude:'))).toBe(true);
    });

    it('sets no-new-privileges security opt', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--security-opt');
      expect(args[idx + 1]).toBe('no-new-privileges');
    });

    it('injects CLAUDE_CODE_OAUTH_TOKEN from the host credentials file', async () => {
      // First readFile call is the prompt; second is ~/.claude/.credentials.json
      mockReadFile
        .mockResolvedValueOnce('mock prompt content')
        .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token-xyz' } }));
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const envArgs = args.filter((_: string, i: number) => args[i - 1] === '-e');
      expect(envArgs.some((a: string) => a.startsWith('CLAUDE_CODE_OAUTH_TOKEN=oauth-token-xyz'))).toBe(true);
    });

    it('injects prompt via _PROMPT env var (no bind mount)', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const envArgs = args.filter((_: string, i: number) => args[i - 1] === '-e');
      expect(envArgs.some((a: string) => a.startsWith('_PROMPT='))).toBe(true);
      // Setup command writes prompt to /tmp/prompt.txt then pipes to claude
      const claudeCmd = getClaudeCmdFromDockerArgs(args);
      expect(claudeCmd).toContain('cat /tmp/prompt.txt');
    });

    it('passes --dangerously-skip-permissions in the claude command', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const claudeCmd = getClaudeCmdFromDockerArgs(args);
      expect(claudeCmd).toContain('--dangerously-skip-permissions');
    });

    it('passes --effort max in the claude command', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { args } = getExecaCall();
      const claudeCmd = getClaudeCmdFromDockerArgs(args);
      expect(claudeCmd).toContain('--effort');
      expect(claudeCmd).toContain('max');
    });

    it('shell-escapes arguments in docker command', async () => {
      await runner.execute(makeAutomation({ sandbox: true, model: "test's-model" }));
      const { args } = getExecaCall();
      const claudeCmd = getClaudeCmdFromDockerArgs(args);
      // Single quotes should be escaped
      expect(claudeCmd).toContain("'test'\\''s-model'");
    });

    it('does not pipe stdin (uses cat from mounted file)', async () => {
      await runner.execute(makeAutomation({ sandbox: true }));
      const { opts } = getExecaCall();
      expect(opts.input).toBeUndefined();
    });

    it('sets stop-timeout from automation timeout', async () => {
      await runner.execute(makeAutomation({ sandbox: true, timeout: 120 }));
      const { args } = getExecaCall();
      const idx = args.indexOf('--stop-timeout');
      expect(args[idx + 1]).toBe('120');
    });
  });

  // ── Sandbox with MCP ───────────────────────────────────────────────────────

  describe('sandbox with MCP config', () => {
    let runner: Runner;

    beforeEach(() => {
      runner = new Runner('/app/mcp.json', true); // MCP + sandbox
      mockClaudeStream([resultEvent()]);
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('mcp')) {
          return Promise.resolve(JSON.stringify({
            mcpServers: {
              gitlab: {
                command: 'node',
                args: ['mcp-servers/gitlab/dist/index.js'],
                env: { GITLAB_URL: '${GITLAB_URL}' },
              },
            },
          }));
        }
        return Promise.resolve('mock prompt content');
      });
    });

    it('injects MCP config via _MCP_CONFIG env var', async () => {
      await runner.execute(makeAutomation({ sandbox: true, mcp: ['gitlab'] }));
      const { args } = getExecaCall();
      const envArgs = args.filter((_: string, i: number) => args[i - 1] === '-e');
      expect(envArgs.some((a: string) => a.startsWith('_MCP_CONFIG='))).toBe(true);
      // Setup command writes MCP config to /tmp/mcp.json inside container
      const claudeCmd = getClaudeCmdFromDockerArgs(args);
      expect(claudeCmd).toContain('> /tmp/mcp.json');
    });

    it('passes --mcp-config /tmp/mcp.json in the claude command', async () => {
      await runner.execute(makeAutomation({ sandbox: true, mcp: ['gitlab'] }));
      const { args } = getExecaCall();
      const claudeCmd = getClaudeCmdFromDockerArgs(args);
      expect(claudeCmd).toContain('--mcp-config');
      expect(claudeCmd).toContain('/tmp/mcp.json');
    });
  });

  // ── Timeout handling ───────────────────────────────────────────────────────

  describe('timeout', () => {
    beforeEach(() => {
      mockClaudeStream([resultEvent()]);
    });

    it('non-sandbox: timeout = automation.timeout * 1000', async () => {
      const runner = new Runner(undefined, false);
      await runner.execute(makeAutomation({ timeout: 120 }));
      const { opts } = getExecaCall();
      expect(opts.timeout).toBe(120_000);
    });

    it('sandbox: timeout = (automation.timeout + 10) * 1000', async () => {
      const runner = new Runner(undefined, true);
      await runner.execute(makeAutomation({ sandbox: true, timeout: 120 }));
      const { opts } = getExecaCall();
      expect(opts.timeout).toBe(130_000);
    });
  });

  // ── Result event error extraction ──────────────────────────────────────────

  describe('result event error extraction', () => {
    let runner: Runner;

    beforeEach(() => {
      runner = new Runner(undefined, false);
    });

    it('uses errors array when event.error is absent and errors is an array', async () => {
      const errorLine = JSON.stringify({
        type: 'result',
        is_error: true,
        errors: ['Reached maximum number of turns (10)'],
        usage: {},
      });
      mockClaudeStream([errorLine]);

      const result = await runner.execute(makeAutomation());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Reached maximum number of turns');
    });

    it('prefers event.error over errors array when both are present', async () => {
      const errorLine = JSON.stringify({
        type: 'result',
        is_error: true,
        error: 'specific error',
        errors: ['some other error'],
        usage: {},
      });
      mockClaudeStream([errorLine]);

      const result = await runner.execute(makeAutomation());

      expect(result.success).toBe(false);
      expect(result.error).toBe('specific error');
    });

    it('falls back to "Claude reported an error" when no error/errors/result fields present', async () => {
      const errorLine = JSON.stringify({
        type: 'result',
        is_error: true,
        usage: {},
      });
      mockClaudeStream([errorLine]);

      const result = await runner.execute(makeAutomation());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claude reported an error');
    });

    it('joins multiple errors array entries with "; "', async () => {
      const errorLine = JSON.stringify({
        type: 'result',
        is_error: true,
        errors: ['Error one', 'Error two'],
        usage: {},
      });
      mockClaudeStream([errorLine]);

      const result = await runner.execute(makeAutomation());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Error one; Error two');
    });
  });
});
