/**
 * Tests for the GET /api/env-vars/[name] handler in
 * web/app/api/env-vars/[name]/route.ts.
 *
 * The critical security contract being verified:
 *   The handler MUST NOT include the `value` field in the JSON response.
 *   It should return metadata (name, description, enabled, created_at,
 *   updated_at) but never the secret value itself.
 *
 * Two complementary strategies are used:
 *
 *   A. Structural analysis — inspect the route source for the destructuring
 *      pattern that strips `value` before serialising (`const { value: _v,
 *      ...safe } = envVar`), confirming the omission is intentional.
 *
 *   B. Functional tests — mock all heavy dependencies, import the exported
 *      GET function directly, and assert on the live Response object.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Path constants ────────────────────────────────────────────────────────────

const ROUTE_PATH = resolve(
  __dirname,
  '../web/app/api/env-vars/[name]/route.ts',
);

// Read the route source synchronously at module load time, before any mocks
// intercept node:fs/promises. The structural tests operate on this string.
const ROUTE_SOURCE = readFileSync(ROUTE_PATH, 'utf-8');

// ── Section A: Structural / source-text assertions ────────────────────────────
//
// These tests operate on ROUTE_SOURCE which is read before vi.mock() hoisting.

describe('GET /api/env-vars/[name] — source structure', () => {
  // ── Imports ─────────────────────────────────────────────────────────────────

  it('imports getEnvVar from @/lib/backend', () => {
    expect(ROUTE_SOURCE).toMatch(
      /import\s*\{[^}]*getEnvVar[^}]*\}\s*from\s*['"]@\/lib\/backend['"]/,
    );
  });

  // ── Exported GET handler ─────────────────────────────────────────────────────

  it('exports an async GET function', () => {
    expect(ROUTE_SOURCE).toMatch(/export\s+async\s+function\s+GET\s*\(/);
  });

  // ── value field omission ─────────────────────────────────────────────────────

  it('destructures value out of the envVar record before responding', () => {
    // The canonical form in the handler is:
    //   const { value: _v, ...safe } = envVar;
    // or any equivalent destructuring that discards `value`.
    expect(ROUTE_SOURCE).toMatch(/\{\s*value\s*:/);
  });

  it('uses a rest spread to build the safe response object', () => {
    // Confirms ...safe (or equivalent) captures the non-value fields.
    expect(ROUTE_SOURCE).toMatch(/\.\.\.\w+\s*\}/);
  });

  it('responds with the safe (no-value) object, not with envVar directly', () => {
    // Response.json must not be called with `envVar` directly — it must be
    // called with the spread that excludes `value`.
    //
    // We check that Response.json is NOT called with the raw `envVar` binding.
    // The safest proxy: confirm `Response.json(envVar)` does NOT appear.
    expect(ROUTE_SOURCE).not.toMatch(/Response\.json\s*\(\s*envVar\s*\)/);
  });

  // ── 404 path ─────────────────────────────────────────────────────────────────

  it('returns a 404 status when the env var is not found', () => {
    expect(ROUTE_SOURCE).toMatch(/status:\s*404/);
  });

  it("returns { error: 'Not found' } for a missing env var", () => {
    expect(ROUTE_SOURCE).toContain('Not found');
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  it('wraps the handler body in try/catch', () => {
    expect(ROUTE_SOURCE).toMatch(/\btry\b/);
    expect(ROUTE_SOURCE).toMatch(/\bcatch\b/);
  });

  it('returns a 500 status on unexpected errors', () => {
    expect(ROUTE_SOURCE).toMatch(/status:\s*500/);
  });
});

// ── Section B: Functional tests with mocked dependencies ─────────────────────
//
// Mock every module that backend.ts transitively imports so we can import the
// route handler and invoke it directly in-process without a database or
// filesystem.

// ── Mock @cronagent/* packages (resolved by vitest.config.ts aliases) ──

vi.mock('@cronagent/loader', () => ({
  loadAutomations: vi.fn().mockResolvedValue([]),
}));

vi.mock('@cronagent/runner', () => ({
  Runner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/history', () => ({
  History: { create: vi.fn().mockResolvedValue({}) },
  DEFAULT_THROTTLE: { enabled: false, maxConcurrent: 5, cooldownSeconds: 0, maxPerHour: 0 },
  DEFAULT_BUDGET: { enabled: false, dailyLimitUsd: 0, monthlyLimitUsd: 0 },
  BudgetConfigSchema: { safeParse: vi.fn().mockReturnValue({ success: false }) },
  EnvVarInputSchema: {
    safeParse: vi.fn().mockReturnValue({
      success: true,
      data: { name: 'MY_VAR', value: '', description: '', enabled: true },
    }),
  },
}));

vi.mock('@cronagent/composer', () => ({
  Composer: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/notifier', () => ({
  Notifier: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/scheduler', () => ({
  Scheduler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/skip-list', () => ({
  SkipList: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/usage-tracker', () => ({
  UsageTracker: vi.fn().mockImplementation(() => ({})),
}));

// ── Mock node:fs/promises ────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock js-yaml ─────────────────────────────────────────────────────────────

vi.mock('js-yaml', () => ({
  default: { dump: vi.fn().mockReturnValue('name: test\n'), load: vi.fn() },
}));

// ── Mock pg (postgres client used by History) ────────────────────────────────

vi.mock('pg', () => ({
  default: { Pool: vi.fn().mockImplementation(() => ({ query: vi.fn(), end: vi.fn() })) },
  Pool: vi.fn().mockImplementation(() => ({ query: vi.fn(), end: vi.fn() })),
}));

// ── Controlled mock of the backend getEnvVar function ────────────────────────

const mockGetEnvVar = vi.fn();

vi.mock('../web/lib/backend.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/lib/backend.ts')>();
  return {
    ...real,
    getEnvVar: (...args: unknown[]) => mockGetEnvVar(...args),
  };
});

// ── Import route handler after all mocks are registered ──────────────────────

import { GET } from '../web/app/api/env-vars/[name]/route.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build the Next.js route context for a given env var name. */
function makeContext(name: string) {
  return { params: Promise.resolve({ name: encodeURIComponent(name) }) };
}

const fakeRequest = {} as Request;

/** A realistic EnvVarRecord with all fields populated, including a secret value. */
function makeRecord(overrides: Partial<{
  name: string;
  value: string;
  description: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}> = {}) {
  return {
    name: 'MY_API_KEY',
    value: 'super-secret-value',
    description: 'API key for the payment gateway',
    enabled: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-03-15T12:00:00Z'),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/env-vars/[name] — functional', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Critical security contract: value is never returned ──────────────────────

  describe('value field exclusion (security contract)', () => {
    it('does NOT include the value field in the response body', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord());

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).not.toHaveProperty('value');
    });

    it('does not leak the secret value string in the response body', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord({ value: 'super-secret-value' }));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      // The secret must not appear anywhere in the serialised response.
      expect(JSON.stringify(body)).not.toContain('super-secret-value');
    });

    it('does not include value even when the value is an empty string', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord({ value: '' }));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).not.toHaveProperty('value');
    });
  });

  // ── Metadata fields that SHOULD be present ────────────────────────────────────

  describe('returned metadata fields', () => {
    it('includes the name field', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord({ name: 'MY_API_KEY' }));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('name', 'MY_API_KEY');
    });

    it('includes the description field', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord({ description: 'A payment gateway key' }));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('description', 'A payment gateway key');
    });

    it('includes the enabled field', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord({ enabled: true }));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('enabled', true);
    });

    it('includes the created_at field', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord());

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('created_at');
    });

    it('includes the updated_at field', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord());

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('updated_at');
    });

    it('returns exactly the five expected metadata fields and no extras', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord());

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      const keys = Object.keys(body).sort();
      expect(keys).toEqual(['created_at', 'description', 'enabled', 'name', 'updated_at']);
    });
  });

  // ── HTTP status codes ─────────────────────────────────────────────────────────

  describe('HTTP status', () => {
    it('returns HTTP 200 when the env var exists', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord());

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));

      expect(res.status).toBe(200);
    });

    it('returns HTTP 404 when the env var does not exist', async () => {
      mockGetEnvVar.mockResolvedValue(undefined);

      const res = await GET(fakeRequest, makeContext('NONEXISTENT'));

      expect(res.status).toBe(404);
    });

    it('returns HTTP 500 when getEnvVar throws an unexpected error', async () => {
      mockGetEnvVar.mockRejectedValue(new Error('Database connection lost'));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));

      expect(res.status).toBe(500);
    });
  });

  // ── 404 response body ─────────────────────────────────────────────────────────

  describe('404 response', () => {
    it('returns an error property when the env var is not found', async () => {
      mockGetEnvVar.mockResolvedValue(undefined);

      const res = await GET(fakeRequest, makeContext('NONEXISTENT'));
      const body = await res.json();

      expect(body).toHaveProperty('error');
    });

    it('calls getEnvVar with the decoded name', async () => {
      mockGetEnvVar.mockResolvedValue(undefined);

      await GET(fakeRequest, makeContext('NONEXISTENT'));

      expect(mockGetEnvVar).toHaveBeenCalledWith('NONEXISTENT');
    });
  });

  // ── 500 response body ─────────────────────────────────────────────────────────

  describe('500 response', () => {
    it('returns an error property with the thrown message', async () => {
      mockGetEnvVar.mockRejectedValue(new Error('Database connection lost'));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('error', 'Database connection lost');
    });

    it('returns the stringified error for non-Error throws', async () => {
      mockGetEnvVar.mockRejectedValue('unexpected failure');

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('error', 'unexpected failure');
    });
  });

  // ── URL decoding ──────────────────────────────────────────────────────────────

  describe('URL decoding', () => {
    it('decodes percent-encoded names before calling getEnvVar', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord({ name: 'MY KEY' }));

      // 'MY KEY' encodes to 'MY%20KEY'; makeContext() calls encodeURIComponent
      await GET(fakeRequest, makeContext('MY KEY'));

      expect(mockGetEnvVar).toHaveBeenCalledWith('MY KEY');
    });
  });

  // ── disabled env var ──────────────────────────────────────────────────────────

  describe('disabled env var', () => {
    it('returns enabled:false without the value field', async () => {
      mockGetEnvVar.mockResolvedValue(makeRecord({ enabled: false }));

      const res = await GET(fakeRequest, makeContext('MY_API_KEY'));
      const body = await res.json();

      expect(body).toHaveProperty('enabled', false);
      expect(body).not.toHaveProperty('value');
    });
  });
});
