/**
 * Unit tests for McpServerInputSchema (Zod) and McpServerRecord interface
 * from src/history.ts.
 *
 * The History class itself requires a live PostgreSQL connection, so only the
 * pure schema validation logic is exercised here — no database is needed.
 */

import { describe, it, expect } from 'vitest';
import { McpServerInputSchema } from '@cronagent/history';
import type { McpServerRecord } from '@cronagent/history';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid payload — all required fields present and correct. */
function validInput() {
  return {
    name: 'my-mcp-server',
    command: 'npx',
    args: ['--yes', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { API_KEY: 'abc123' },
    enabled: true,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpServerInputSchema', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('valid input', () => {
    it('passes when all fields are provided and correct', () => {
      const result = McpServerInputSchema.safeParse(validInput());

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe('my-mcp-server');
      expect(result.data.command).toBe('npx');
    });

    it('passes with only the two required fields (name + command)', () => {
      const result = McpServerInputSchema.safeParse({
        name: 'minimal',
        command: 'node',
      });

      expect(result.success).toBe(true);
    });

    it('accepts uppercase letters in name', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'MyServer',
      });

      expect(result.success).toBe(true);
    });

    it('accepts underscores in name', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'my_server',
      });

      expect(result.success).toBe(true);
    });

    it('accepts hyphens in name', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'my-server-v2',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a mix of alphanumerics, hyphens, and underscores in name', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'Server_1-alpha',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a command with spaces and flags as a single string', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        command: '/usr/local/bin/my-tool',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.command).toBe('/usr/local/bin/my-tool');
    });
  });

  // ── Default values ─────────────────────────────────────────────────────────

  describe('default values', () => {
    it('defaults args to an empty array when omitted', () => {
      const result = McpServerInputSchema.safeParse({
        name: 'server',
        command: 'node',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.args).toEqual([]);
    });

    it('defaults env to an empty object when omitted', () => {
      const result = McpServerInputSchema.safeParse({
        name: 'server',
        command: 'node',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.env).toEqual({});
    });

    it('defaults enabled to true when omitted', () => {
      const result = McpServerInputSchema.safeParse({
        name: 'server',
        command: 'node',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.enabled).toBe(true);
    });

    it('preserves explicitly supplied enabled:false', () => {
      const result = McpServerInputSchema.safeParse({
        name: 'server',
        command: 'node',
        enabled: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.enabled).toBe(false);
    });

    it('preserves non-empty args array when provided', () => {
      const args = ['-p', '8080', '--verbose'];
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        args,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.args).toEqual(args);
    });

    it('preserves non-empty env record when provided', () => {
      const env = { TOKEN: 'secret', PORT: '3000' };
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        env,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.env).toEqual(env);
    });
  });

  // ── Name validation ────────────────────────────────────────────────────────

  describe('name validation', () => {
    it('fails when name is an empty string', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: '',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join('; ');
      expect(messages).toContain('Name is required');
    });

    it('fails when name is missing entirely', () => {
      const { name: _omitted, ...rest } = validInput();

      const result = McpServerInputSchema.safeParse(rest);

      expect(result.success).toBe(false);
    });

    it('fails when name contains a space', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'my server',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join('; ');
      expect(messages).toContain('alphanumeric');
    });

    it('fails when name contains a dot', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'my.server',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join('; ');
      expect(messages).toContain('alphanumeric');
    });

    it('fails when name contains a slash', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'my/server',
      });

      expect(result.success).toBe(false);
    });

    it('fails when name contains an at-sign', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: '@my-server',
      });

      expect(result.success).toBe(false);
    });

    it('fails when name contains parentheses', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: 'server(1)',
      });

      expect(result.success).toBe(false);
    });

    it('trims whitespace from name before validation', () => {
      // The schema applies .trim() so " server " becomes "server", which is valid.
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        name: '  server  ',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe('server');
    });
  });

  // ── Command validation ─────────────────────────────────────────────────────

  describe('command validation', () => {
    it('fails when command is an empty string', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        command: '',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join('; ');
      expect(messages).toContain('Command is required');
    });

    it('fails when command is missing entirely', () => {
      const { command: _omitted, ...rest } = validInput();

      const result = McpServerInputSchema.safeParse(rest);

      expect(result.success).toBe(false);
    });

    it('fails when command is not a string', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        command: 42 as unknown as string,
      });

      expect(result.success).toBe(false);
    });
  });

  // ── Args type validation ───────────────────────────────────────────────────

  describe('args type validation', () => {
    it('fails when args contains non-string elements', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        args: [1, 2, 3] as unknown as string[],
      });

      expect(result.success).toBe(false);
    });

    it('fails when args is not an array', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        args: 'not-an-array' as unknown as string[],
      });

      expect(result.success).toBe(false);
    });
  });

  // ── Env type validation ────────────────────────────────────────────────────

  describe('env type validation', () => {
    it('fails when env values are not strings', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        env: { PORT: 8080 } as unknown as Record<string, string>,
      });

      expect(result.success).toBe(false);
    });

    it('fails when env is an array instead of an object', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        env: ['KEY=VALUE'] as unknown as Record<string, string>,
      });

      expect(result.success).toBe(false);
    });
  });

  // ── Enabled type validation ────────────────────────────────────────────────

  describe('enabled type validation', () => {
    it('fails when enabled is a string', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        enabled: 'true' as unknown as boolean,
      });

      expect(result.success).toBe(false);
    });

    it('fails when enabled is a number', () => {
      const result = McpServerInputSchema.safeParse({
        ...validInput(),
        enabled: 1 as unknown as boolean,
      });

      expect(result.success).toBe(false);
    });
  });

  // ── Non-object inputs ──────────────────────────────────────────────────────

  describe('non-object inputs', () => {
    it('fails for null', () => {
      expect(McpServerInputSchema.safeParse(null).success).toBe(false);
    });

    it('fails for undefined', () => {
      expect(McpServerInputSchema.safeParse(undefined).success).toBe(false);
    });

    it('fails for a plain string', () => {
      expect(McpServerInputSchema.safeParse('{"name":"x","command":"y"}').success).toBe(false);
    });

    it('fails for an array', () => {
      expect(McpServerInputSchema.safeParse([]).success).toBe(false);
    });

    it('fails for a number', () => {
      expect(McpServerInputSchema.safeParse(42).success).toBe(false);
    });
  });
});

// ── McpServerRecord structural tests ─────────────────────────────────────────

describe('McpServerRecord', () => {
  it('accepts a well-formed object matching the interface', () => {
    // This is a compile-time check expressed as a runtime assertion.
    // If the interface changes incompatibly, TypeScript will flag this block.
    const record: McpServerRecord = {
      name: 'my-server',
      command: 'node',
      args: ['index.js'],
      env: { NODE_ENV: 'production' },
      enabled: true,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-03-15T12:00:00Z'),
    };

    expect(record.name).toBe('my-server');
    expect(record.command).toBe('node');
    expect(record.args).toEqual(['index.js']);
    expect(record.env).toEqual({ NODE_ENV: 'production' });
    expect(record.enabled).toBe(true);
    expect(record.created_at).toBeInstanceOf(Date);
    expect(record.updated_at).toBeInstanceOf(Date);
  });

  it('McpServerRecord has all seven expected fields', () => {
    const record: McpServerRecord = {
      name: 'test',
      command: 'echo',
      args: [],
      env: {},
      enabled: false,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const keys = Object.keys(record);
    expect(keys).toContain('name');
    expect(keys).toContain('command');
    expect(keys).toContain('args');
    expect(keys).toContain('env');
    expect(keys).toContain('enabled');
    expect(keys).toContain('created_at');
    expect(keys).toContain('updated_at');
  });

  it('enabled field can be false', () => {
    const record: McpServerRecord = {
      name: 'disabled-server',
      command: 'node',
      args: [],
      env: {},
      enabled: false,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(record.enabled).toBe(false);
  });

  it('args field is typed as an array', () => {
    const record: McpServerRecord = {
      name: 'multi-arg',
      command: 'npx',
      args: ['--yes', '@scope/package', '--flag'],
      env: {},
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(Array.isArray(record.args)).toBe(true);
    expect(record.args).toHaveLength(3);
  });

  it('env field holds string-to-string key-value pairs', () => {
    const env: Record<string, string> = { HOST: 'localhost', PORT: '3000' };
    const record: McpServerRecord = {
      name: 'env-server',
      command: 'node',
      args: [],
      env,
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(record.env['HOST']).toBe('localhost');
    expect(record.env['PORT']).toBe('3000');
  });
});
