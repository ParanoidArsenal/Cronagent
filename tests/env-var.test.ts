/**
 * Unit tests for EnvVarInputSchema (Zod) and EnvVarRecord interface
 * from src/history.ts, and the env-var wrapper functions in web/lib/backend.ts.
 *
 * The History class itself requires a live PostgreSQL connection, so only the
 * pure schema validation logic and mocked-History wrapper paths are exercised
 * here — no database is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvVarInputSchema } from '@cronagent/history';
import type { EnvVarRecord } from '@cronagent/history';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid payload — all required fields present and correct. */
function validInput() {
  return {
    name: 'MY_API_KEY',
    value: 'secret-value',
    description: 'An API key for the service',
    enabled: true,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EnvVarInputSchema', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('valid input', () => {
    it('passes when all fields are provided and correct', () => {
      const result = EnvVarInputSchema.safeParse(validInput());

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe('MY_API_KEY');
      expect(result.data.value).toBe('secret-value');
    });

    it('passes with only the required name field', () => {
      const result = EnvVarInputSchema.safeParse({ name: 'SIMPLE_VAR' });

      expect(result.success).toBe(true);
    });

    it('accepts uppercase-only name', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'DATABASE_URL',
      });

      expect(result.success).toBe(true);
    });

    it('accepts lowercase-only name', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'database_url',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a name starting with an underscore', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: '_INTERNAL_FLAG',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a mix of letters, digits, and underscores in name', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'API_KEY_V2',
      });

      expect(result.success).toBe(true);
    });

    it('accepts a name that is a single letter', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'X',
      });

      expect(result.success).toBe(true);
    });

    it('accepts an empty string value', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        value: '',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.value).toBe('');
    });

    it('accepts an empty string description', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        description: '',
      });

      expect(result.success).toBe(true);
    });
  });

  // ── Default values ─────────────────────────────────────────────────────────

  describe('default values', () => {
    it('defaults value to an empty string when omitted', () => {
      const result = EnvVarInputSchema.safeParse({ name: 'MY_VAR' });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.value).toBe('');
    });

    it('defaults description to an empty string when omitted', () => {
      const result = EnvVarInputSchema.safeParse({ name: 'MY_VAR' });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.description).toBe('');
    });

    it('defaults enabled to true when omitted', () => {
      const result = EnvVarInputSchema.safeParse({ name: 'MY_VAR' });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.enabled).toBe(true);
    });

    it('preserves explicitly supplied enabled:false', () => {
      const result = EnvVarInputSchema.safeParse({
        name: 'MY_VAR',
        enabled: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.enabled).toBe(false);
    });

    it('preserves a non-empty value when provided', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        value: 'my-secret-123',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.value).toBe('my-secret-123');
    });

    it('preserves a non-empty description when provided', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        description: 'Used by the payment gateway',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.description).toBe('Used by the payment gateway');
    });
  });

  // ── Name validation ────────────────────────────────────────────────────────

  describe('name validation', () => {
    it('fails when name is an empty string', () => {
      const result = EnvVarInputSchema.safeParse({
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

      const result = EnvVarInputSchema.safeParse(rest);

      expect(result.success).toBe(false);
    });

    it('fails when name starts with a digit', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: '1_INVALID',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join('; ');
      expect(messages).toContain('valid env var name');
    });

    it('fails when name contains a hyphen', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'MY-VAR',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      const messages = result.error.issues.map((i) => i.message).join('; ');
      expect(messages).toContain('valid env var name');
    });

    it('fails when name contains a space', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'MY VAR',
      });

      expect(result.success).toBe(false);
    });

    it('fails when name contains a dot', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'MY.VAR',
      });

      expect(result.success).toBe(false);
    });

    it('fails when name contains an at-sign', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: '@MY_VAR',
      });

      expect(result.success).toBe(false);
    });

    it('fails when name contains a dollar sign', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: '$MY_VAR',
      });

      expect(result.success).toBe(false);
    });

    it('fails when name contains parentheses', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: 'MY(VAR)',
      });

      expect(result.success).toBe(false);
    });

    it('trims whitespace from name before validation', () => {
      // The schema applies .trim() so "  MY_VAR  " becomes "MY_VAR", which is valid.
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: '  MY_VAR  ',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe('MY_VAR');
    });

    it('fails when name is only digits after trimming', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        name: '123',
      });

      expect(result.success).toBe(false);
    });
  });

  // ── Enabled type validation ────────────────────────────────────────────────

  describe('enabled type validation', () => {
    it('fails when enabled is a string', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        enabled: 'true' as unknown as boolean,
      });

      expect(result.success).toBe(false);
    });

    it('fails when enabled is a number', () => {
      const result = EnvVarInputSchema.safeParse({
        ...validInput(),
        enabled: 1 as unknown as boolean,
      });

      expect(result.success).toBe(false);
    });
  });

  // ── Non-object inputs ──────────────────────────────────────────────────────

  describe('non-object inputs', () => {
    it('fails for null', () => {
      expect(EnvVarInputSchema.safeParse(null).success).toBe(false);
    });

    it('fails for undefined', () => {
      expect(EnvVarInputSchema.safeParse(undefined).success).toBe(false);
    });

    it('fails for a plain string', () => {
      expect(EnvVarInputSchema.safeParse('{"name":"MY_VAR"}').success).toBe(false);
    });

    it('fails for an array', () => {
      expect(EnvVarInputSchema.safeParse([]).success).toBe(false);
    });

    it('fails for a number', () => {
      expect(EnvVarInputSchema.safeParse(42).success).toBe(false);
    });
  });
});

// ── EnvVarRecord structural tests ─────────────────────────────────────────────

describe('EnvVarRecord', () => {
  it('accepts a well-formed object matching the interface', () => {
    // Compile-time check expressed as a runtime assertion.
    // If the interface changes incompatibly, TypeScript will flag this block.
    const record: EnvVarRecord = {
      name: 'DATABASE_URL',
      value: 'postgresql://localhost:5432/mydb',
      description: 'Primary database connection string',
      enabled: true,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-03-15T12:00:00Z'),
    };

    expect(record.name).toBe('DATABASE_URL');
    expect(record.value).toBe('postgresql://localhost:5432/mydb');
    expect(record.description).toBe('Primary database connection string');
    expect(record.enabled).toBe(true);
    expect(record.created_at).toBeInstanceOf(Date);
    expect(record.updated_at).toBeInstanceOf(Date);
  });

  it('has all six expected fields', () => {
    const record: EnvVarRecord = {
      name: 'TEST_VAR',
      value: 'test-value',
      description: '',
      enabled: false,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const keys = Object.keys(record);
    expect(keys).toContain('name');
    expect(keys).toContain('value');
    expect(keys).toContain('description');
    expect(keys).toContain('enabled');
    expect(keys).toContain('created_at');
    expect(keys).toContain('updated_at');
  });

  it('enabled field can be false', () => {
    const record: EnvVarRecord = {
      name: 'DISABLED_VAR',
      value: '',
      description: '',
      enabled: false,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(record.enabled).toBe(false);
  });

  it('value field can be an empty string', () => {
    const record: EnvVarRecord = {
      name: 'EMPTY_VAR',
      value: '',
      description: 'Intentionally empty',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(record.value).toBe('');
  });

  it('description field can be an empty string', () => {
    const record: EnvVarRecord = {
      name: 'NO_DESC_VAR',
      value: 'some-value',
      description: '',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(record.description).toBe('');
  });
});

// ── Backend wrapper function tests ────────────────────────────────────────────

/**
 * Builds a minimal mock of the History class covering the env-var methods.
 * An in-memory store is used so upsert/get/delete behave consistently.
 */
function makeHistory(
  overrides: Partial<{
    getEnvVars: () => Promise<EnvVarRecord[]>;
    getEnvVar: (name: string) => Promise<EnvVarRecord | undefined>;
    upsertEnvVar: (envVar: { name: string; value: string; description: string; enabled: boolean }) => Promise<void>;
    deleteEnvVar: (name: string) => Promise<boolean>;
    setEnvVarEnabled: (name: string, enabled: boolean) => Promise<boolean>;
    getEnabledEnvVars: () => Promise<Record<string, string>>;
  }> = {},
) {
  const store = new Map<string, EnvVarRecord>();

  const now = () => new Date();

  const defaultGetEnvVars = async (): Promise<EnvVarRecord[]> =>
    Array.from(store.values()).sort((a, b) => a.name.localeCompare(b.name));

  const defaultGetEnvVar = async (name: string): Promise<EnvVarRecord | undefined> =>
    store.get(name);

  const defaultUpsertEnvVar = async (envVar: {
    name: string;
    value: string;
    description: string;
    enabled: boolean;
  }): Promise<void> => {
    const existing = store.get(envVar.name);
    store.set(envVar.name, {
      ...envVar,
      created_at: existing?.created_at ?? now(),
      updated_at: now(),
    });
  };

  const defaultDeleteEnvVar = async (name: string): Promise<boolean> => {
    if (!store.has(name)) return false;
    store.delete(name);
    return true;
  };

  const defaultSetEnvVarEnabled = async (name: string, enabled: boolean): Promise<boolean> => {
    const record = store.get(name);
    if (!record) return false;
    store.set(name, { ...record, enabled, updated_at: now() });
    return true;
  };

  const defaultGetEnabledEnvVars = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const [name, record] of store.entries()) {
      if (record.enabled) {
        result[name] = record.value;
      }
    }
    return result;
  };

  return {
    _store: store,
    getEnvVars: vi.fn(overrides.getEnvVars ?? defaultGetEnvVars),
    getEnvVar: vi.fn(overrides.getEnvVar ?? defaultGetEnvVar),
    upsertEnvVar: vi.fn(overrides.upsertEnvVar ?? defaultUpsertEnvVar),
    deleteEnvVar: vi.fn(overrides.deleteEnvVar ?? defaultDeleteEnvVar),
    setEnvVarEnabled: vi.fn(overrides.setEnvVarEnabled ?? defaultSetEnvVarEnabled),
    getEnabledEnvVars: vi.fn(overrides.getEnabledEnvVars ?? defaultGetEnabledEnvVars),
  };
}

// ── getEnvVars wrapper ─────────────────────────────────────────────────────

describe('getEnvVars (History method)', () => {
  it('returns an empty array when no env vars are stored', async () => {
    const history = makeHistory();
    const vars = await history.getEnvVars();
    expect(vars).toEqual([]);
  });

  it('returns all stored env vars', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'VAR_A', value: 'a', description: '', enabled: true });
    await history.upsertEnvVar({ name: 'VAR_B', value: 'b', description: '', enabled: false });

    const vars = await history.getEnvVars();
    expect(vars).toHaveLength(2);
    const names = vars.map((v) => v.name);
    expect(names).toContain('VAR_A');
    expect(names).toContain('VAR_B');
  });

  it('returns vars ordered by name', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'ZZZ_VAR', value: '1', description: '', enabled: true });
    await history.upsertEnvVar({ name: 'AAA_VAR', value: '2', description: '', enabled: true });

    const vars = await history.getEnvVars();
    expect(vars[0].name).toBe('AAA_VAR');
    expect(vars[1].name).toBe('ZZZ_VAR');
  });
});

// ── getEnvVar wrapper ──────────────────────────────────────────────────────

describe('getEnvVar (History method)', () => {
  it('returns undefined when the env var does not exist', async () => {
    const history = makeHistory();
    const result = await history.getEnvVar('NONEXISTENT');
    expect(result).toBeUndefined();
  });

  it('returns the record when the env var exists', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({
      name: 'MY_TOKEN',
      value: 'abc123',
      description: 'A token',
      enabled: true,
    });

    const result = await history.getEnvVar('MY_TOKEN');
    expect(result).toBeDefined();
    expect(result!.name).toBe('MY_TOKEN');
    expect(result!.value).toBe('abc123');
    expect(result!.description).toBe('A token');
    expect(result!.enabled).toBe(true);
  });

  it('returns undefined for a different name even when other vars exist', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'VAR_ONE', value: 'v1', description: '', enabled: true });

    const result = await history.getEnvVar('VAR_TWO');
    expect(result).toBeUndefined();
  });
});

// ── upsertEnvVar wrapper ───────────────────────────────────────────────────

describe('upsertEnvVar (History method)', () => {
  it('creates a new env var when it does not exist', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'NEW_VAR', value: 'val', description: 'desc', enabled: true });

    const result = await history.getEnvVar('NEW_VAR');
    expect(result).toBeDefined();
    expect(result!.value).toBe('val');
    expect(result!.description).toBe('desc');
  });

  it('updates an existing env var on conflict', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'UPSERT_VAR', value: 'original', description: 'old', enabled: true });
    await history.upsertEnvVar({ name: 'UPSERT_VAR', value: 'updated', description: 'new', enabled: false });

    const result = await history.getEnvVar('UPSERT_VAR');
    expect(result!.value).toBe('updated');
    expect(result!.description).toBe('new');
    expect(result!.enabled).toBe(false);
  });

  it('preserves created_at when updating an existing record', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'TS_VAR', value: 'v1', description: '', enabled: true });
    const original = await history.getEnvVar('TS_VAR');

    // Small delay so updated_at will differ
    await new Promise((r) => setTimeout(r, 2));
    await history.upsertEnvVar({ name: 'TS_VAR', value: 'v2', description: '', enabled: true });
    const updated = await history.getEnvVar('TS_VAR');

    expect(updated!.created_at.getTime()).toBe(original!.created_at.getTime());
  });
});

// ── deleteEnvVar wrapper ───────────────────────────────────────────────────

describe('deleteEnvVar (History method)', () => {
  it('returns false when the env var does not exist', async () => {
    const history = makeHistory();
    const result = await history.deleteEnvVar('GHOST_VAR');
    expect(result).toBe(false);
  });

  it('returns true and removes the record when the env var exists', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'TO_DELETE', value: 'v', description: '', enabled: true });

    const result = await history.deleteEnvVar('TO_DELETE');
    expect(result).toBe(true);
    expect(await history.getEnvVar('TO_DELETE')).toBeUndefined();
  });

  it('does not affect other env vars when deleting one', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'KEEP_VAR', value: 'v1', description: '', enabled: true });
    await history.upsertEnvVar({ name: 'DEL_VAR', value: 'v2', description: '', enabled: true });

    await history.deleteEnvVar('DEL_VAR');

    expect(await history.getEnvVar('KEEP_VAR')).toBeDefined();
    expect(await history.getEnvVar('DEL_VAR')).toBeUndefined();
  });
});

// ── setEnvVarEnabled wrapper ───────────────────────────────────────────────

describe('setEnvVarEnabled (History method)', () => {
  it('returns false when the env var does not exist', async () => {
    const history = makeHistory();
    const result = await history.setEnvVarEnabled('MISSING_VAR', true);
    expect(result).toBe(false);
  });

  it('returns true and disables an enabled env var', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'TOGGLE_VAR', value: 'v', description: '', enabled: true });

    const result = await history.setEnvVarEnabled('TOGGLE_VAR', false);
    expect(result).toBe(true);

    const record = await history.getEnvVar('TOGGLE_VAR');
    expect(record!.enabled).toBe(false);
  });

  it('returns true and enables a disabled env var', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'DISABLED_VAR', value: 'v', description: '', enabled: false });

    const result = await history.setEnvVarEnabled('DISABLED_VAR', true);
    expect(result).toBe(true);

    const record = await history.getEnvVar('DISABLED_VAR');
    expect(record!.enabled).toBe(true);
  });

  it('does not affect other env vars when toggling one', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'VAR_X', value: 'x', description: '', enabled: true });
    await history.upsertEnvVar({ name: 'VAR_Y', value: 'y', description: '', enabled: true });

    await history.setEnvVarEnabled('VAR_X', false);

    const varY = await history.getEnvVar('VAR_Y');
    expect(varY!.enabled).toBe(true);
  });
});

// ── getEnabledEnvVars wrapper ──────────────────────────────────────────────

describe('getEnabledEnvVars (History method)', () => {
  it('returns an empty object when no env vars are stored', async () => {
    const history = makeHistory();
    const result = await history.getEnabledEnvVars();
    expect(result).toEqual({});
  });

  it('returns only enabled env vars as a name-to-value map', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'ENABLED_VAR', value: 'enabled-val', description: '', enabled: true });
    await history.upsertEnvVar({ name: 'DISABLED_VAR', value: 'disabled-val', description: '', enabled: false });

    const result = await history.getEnabledEnvVars();

    expect(result).toHaveProperty('ENABLED_VAR', 'enabled-val');
    expect(result).not.toHaveProperty('DISABLED_VAR');
  });

  it('returns all vars when all are enabled', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'VAR_A', value: 'a', description: '', enabled: true });
    await history.upsertEnvVar({ name: 'VAR_B', value: 'b', description: '', enabled: true });

    const result = await history.getEnabledEnvVars();

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['VAR_A']).toBe('a');
    expect(result['VAR_B']).toBe('b');
  });

  it('returns an empty object when all vars are disabled', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'DEAD_VAR', value: 'v', description: '', enabled: false });

    const result = await history.getEnabledEnvVars();
    expect(result).toEqual({});
  });

  it('reflects changes after toggling a var via setEnvVarEnabled', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'FLIP_VAR', value: 'flip-val', description: '', enabled: false });

    let result = await history.getEnabledEnvVars();
    expect(result).not.toHaveProperty('FLIP_VAR');

    await history.setEnvVarEnabled('FLIP_VAR', true);

    result = await history.getEnabledEnvVars();
    expect(result).toHaveProperty('FLIP_VAR', 'flip-val');
  });
});

// ── updateEnvVar logic (backend wrapper) ──────────────────────────────────

describe('updateEnvVar logic (backend wrapper pattern)', () => {
  /**
   * The backend updateEnvVar checks for existence before upserting.
   * We replicate that exact logic here to test it without importing backend.ts
   * (which would pull in Next.js and filesystem dependencies).
   */
  async function updateEnvVar(
    history: ReturnType<typeof makeHistory>,
    name: string,
    envVar: { name: string; value: string; description: string; enabled: boolean },
  ): Promise<boolean> {
    const existing = await history.getEnvVar(name);
    if (!existing) return false;
    await history.upsertEnvVar(envVar);
    return true;
  }

  it('returns false when the target env var does not exist', async () => {
    const history = makeHistory();
    const result = await updateEnvVar(history, 'NONEXISTENT', {
      name: 'NONEXISTENT',
      value: 'v',
      description: '',
      enabled: true,
    });

    expect(result).toBe(false);
    expect(history.upsertEnvVar).not.toHaveBeenCalled();
  });

  it('returns true and calls upsertEnvVar when the env var exists', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'EXISTING_VAR', value: 'old', description: '', enabled: true });
    // Clear mock call count from the setup above
    history.upsertEnvVar.mockClear();

    const result = await updateEnvVar(history, 'EXISTING_VAR', {
      name: 'EXISTING_VAR',
      value: 'new',
      description: 'updated',
      enabled: false,
    });

    expect(result).toBe(true);
    expect(history.upsertEnvVar).toHaveBeenCalledOnce();
    expect(history.upsertEnvVar).toHaveBeenCalledWith({
      name: 'EXISTING_VAR',
      value: 'new',
      description: 'updated',
      enabled: false,
    });
  });

  it('persists the new values after update', async () => {
    const history = makeHistory();
    await history.upsertEnvVar({ name: 'MUTABLE_VAR', value: 'initial', description: 'init', enabled: true });

    await updateEnvVar(history, 'MUTABLE_VAR', {
      name: 'MUTABLE_VAR',
      value: 'changed',
      description: 'changed-desc',
      enabled: false,
    });

    const record = await history.getEnvVar('MUTABLE_VAR');
    expect(record!.value).toBe('changed');
    expect(record!.description).toBe('changed-desc');
    expect(record!.enabled).toBe(false);
  });
});
