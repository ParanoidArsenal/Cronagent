/**
 * Tests for the DELETE /api/automations/[name] handler in
 * web/app/api/automations/[name]/route.ts.
 *
 * The handler is responsible for:
 *   1. Calling setCronEnabled(name, false) so the daemon (the sole cron
 *      executor) stops firing it — the web process registers no crons
 *   2. Proceeding with deletion even when setCronEnabled throws (DB down)
 *   4. Returning 404 when the automation does not exist
 *   5. Returning { deleted: true } on success
 *
 * Because Next.js route modules use complex async params and rely on
 * heavy runtime deps, this file uses two complementary strategies:
 *
 *   A. Structural analysis — parse the TypeScript source and assert on
 *      the text patterns the handler must contain (mirrors entrypoint.test.ts).
 *
 *   B. Functional tests — mock all @cronagent/* and node builtins,
 *      then import and call the exported DELETE function directly
 *      (mirrors parseAutomationInput.test.ts mock setup style).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Path constants ────────────────────────────────────────────────────────────

const ROUTE_PATH = resolve(
  __dirname,
  '../web/app/api/automations/[name]/route.ts',
);

// Read the route source synchronously at module load time, before any mocks
// intercept node:fs/promises. The structural tests operate on this string.
const ROUTE_SOURCE = readFileSync(ROUTE_PATH, 'utf-8');
const ROUTE_LINES = ROUTE_SOURCE.split('\n');

// ── Section A: Structural / source-text assertions ────────────────────────────
//
// These tests operate on ROUTE_SOURCE / ROUTE_LINES, which are read
// synchronously before any vi.mock() hoisting can shadow node:fs.

describe('DELETE /api/automations/[name] — source structure', () => {
  // ── Imports ─────────────────────────────────────────────────────────────────

  it('does not use an in-process scheduler (daemon owns cron)', () => {
    expect(ROUTE_SOURCE).not.toContain('getScheduler');
    expect(ROUTE_SOURCE).not.toContain('stopOne');
  });

  it('imports setCronEnabled from @/lib/backend', () => {
    expect(ROUTE_SOURCE).toMatch(
      /import\s*\{[^}]*setCronEnabled[^}]*\}\s*from\s*['"]@\/lib\/backend['"]/,
    );
  });

  it('imports deleteAutomation from @/lib/backend', () => {
    expect(ROUTE_SOURCE).toMatch(
      /import\s*\{[^}]*deleteAutomation[^}]*\}\s*from\s*['"]@\/lib\/backend['"]/,
    );
  });

  // ── DELETE function presence ────────────────────────────────────────────────

  it('exports an async DELETE function', () => {
    expect(ROUTE_SOURCE).toMatch(/export\s+async\s+function\s+DELETE\s*\(/);
  });

  // ── setCronEnabled call ─────────────────────────────────────────────────────

  it('calls setCronEnabled', () => {
    expect(ROUTE_SOURCE).toContain('setCronEnabled');
  });

  it('calls setCronEnabled with false to disable the cron state', () => {
    expect(ROUTE_SOURCE).toMatch(/setCronEnabled\s*\(\s*decodedName\s*,\s*false\s*\)/);
  });

  // ── try/catch wrapping ──────────────────────────────────────────────────────

  it('wraps the cron-disable block in try/catch', () => {
    // Both 'try' and 'catch' must appear before 'deleteAutomation' in the
    // DELETE function body so that DB errors are swallowed.
    const deleteFnStart = ROUTE_LINES.findIndex((l) => l.includes('export async function DELETE'));
    expect(deleteFnStart).toBeGreaterThan(-1);

    const bodyLines = ROUTE_LINES.slice(deleteFnStart);
    const tryIdx = bodyLines.findIndex((l) => /\btry\b/.test(l));
    const catchIdx = bodyLines.findIndex((l) => /\bcatch\b/.test(l));
    const deleteCallIdx = bodyLines.findIndex((l) => l.includes('deleteAutomation'));

    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    // deleteAutomation must come AFTER the catch — meaning the try/catch
    // wraps only the cron-disable block, not the deletion itself.
    expect(deleteCallIdx).toBeGreaterThan(catchIdx);
  });

  it('setCronEnabled is called inside the try block (before the catch)', () => {
    const deleteFnStart = ROUTE_LINES.findIndex((l) => l.includes('export async function DELETE'));
    const bodyLines = ROUTE_LINES.slice(deleteFnStart);

    const tryIdx = bodyLines.findIndex((l) => /\btry\b/.test(l));
    const catchIdx = bodyLines.findIndex((l) => /\bcatch\b/.test(l));
    const setCronIdx = bodyLines.findIndex((l) => l.includes('setCronEnabled'));

    expect(setCronIdx).toBeGreaterThan(tryIdx);
    expect(setCronIdx).toBeLessThan(catchIdx);
  });

  // ── Ordering: disable before delete ─────────────────────────────────────────

  it('calls setCronEnabled before deleteAutomation', () => {
    const setCronIdx = ROUTE_SOURCE.indexOf('setCronEnabled(');
    const deleteCallIdx = ROUTE_SOURCE.indexOf('deleteAutomation(');
    expect(setCronIdx).toBeGreaterThan(-1);
    expect(deleteCallIdx).toBeGreaterThan(-1);
    expect(setCronIdx).toBeLessThan(deleteCallIdx);
  });

  // ── 404 path ────────────────────────────────────────────────────────────────

  it('returns a 404 response when the automation is not found', () => {
    expect(ROUTE_SOURCE).toMatch(/status:\s*404/);
  });

  // ── Success response ─────────────────────────────────────────────────────────

  it('returns { deleted: true } on success', () => {
    expect(ROUTE_SOURCE).toContain('deleted: true');
  });
});

// ── Section B: Functional tests with mocked dependencies ─────────────────────
//
// Mock every module that backend.ts imports so we can import the route handler
// and call it directly in-process.

// ── Mock @cronagent/* packages (resolved by vitest.config.ts aliases) ──

const mockSetCronEnabled = vi.fn().mockResolvedValue(undefined);
const mockDeleteAutomation = vi.fn();
const mockGetAutomations = vi.fn();

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
}));

vi.mock('@cronagent/composer', () => ({
  Composer: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/notifier', () => ({
  Notifier: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/scheduler', () => ({
  CRON_ENABLED_PREFIX: 'cron_enabled::',
  nextCronRun: vi.fn().mockReturnValue(null),
}));

vi.mock('@cronagent/skip-list', () => ({
  SkipList: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/usage-tracker', () => ({
  UsageTracker: vi.fn().mockImplementation(() => ({})),
}));

// ── Mock node:fs/promises so no real filesystem access occurs ─────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock js-yaml (used by backend.ts) ────────────────────────────────────────

vi.mock('js-yaml', () => ({
  default: { dump: vi.fn().mockReturnValue('name: test\n'), load: vi.fn() },
}));

// ── Intercept @/lib/backend so we can control setCronEnabled, etc. ───────────
//
// The route file imports from '@/lib/backend'. There is no '@/' alias in
// vitest.config.ts, so Vitest resolves it via Next.js tsconfig path mapping.
// We mock the module path that the bundler resolves to.

vi.mock('../web/lib/backend.ts', async (importOriginal) => {
  // Pull in the real module so parseAutomationInput etc. still work if needed.
  // For this test suite we only need to override the three functions the DELETE
  // handler calls.
  const real = await importOriginal<typeof import('../web/lib/backend.ts')>();
  return {
    ...real,
    setCronEnabled: (...args: unknown[]) => mockSetCronEnabled(...args),
    deleteAutomation: (...args: unknown[]) => mockDeleteAutomation(...args),
    getAutomations: (...args: unknown[]) => mockGetAutomations(...args),
  };
});

// ── Import route handler after all mocks are registered ──────────────────────

import { DELETE } from '../web/app/api/automations/[name]/route.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build the Next.js route context for a given automation name. */
function makeContext(name: string) {
  return { params: Promise.resolve({ name: encodeURIComponent(name) }) };
}

const fakeRequest = {} as Request;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/automations/[name] — functional', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSetCronEnabled.mockResolvedValue(undefined);
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('when automation exists', () => {
    beforeEach(() => {
      // deleteAutomation returns true → automation found and deleted
      mockDeleteAutomation.mockResolvedValue(true);
    });

    it('returns { deleted: true }', async () => {
      const res = await DELETE(fakeRequest, makeContext('my-job'));
      const body = await res.json();
      expect(body).toEqual({ deleted: true });
    });

    it('returns HTTP 200', async () => {
      const res = await DELETE(fakeRequest, makeContext('my-job'));
      expect(res.status).toBe(200);
    });

    it('calls setCronEnabled(name, false)', async () => {
      await DELETE(fakeRequest, makeContext('my-job'));
      expect(mockSetCronEnabled).toHaveBeenCalledWith('my-job', false);
    });

    it('calls setCronEnabled before deleteAutomation', async () => {
      const callOrder: string[] = [];
      mockSetCronEnabled.mockImplementation(() => { callOrder.push('setCronEnabled'); return Promise.resolve(undefined); });
      mockDeleteAutomation.mockImplementation(() => { callOrder.push('deleteAutomation'); return Promise.resolve(true); });

      await DELETE(fakeRequest, makeContext('my-job'));

      expect(callOrder.indexOf('setCronEnabled')).toBeLessThan(callOrder.indexOf('deleteAutomation'));
    });

    it('URL-decodes percent-encoded names before use', async () => {
      await DELETE(fakeRequest, makeContext('my job'));  // space becomes %20
      expect(mockSetCronEnabled).toHaveBeenCalledWith('my job', false);
    });
  });

  // ── 404 path ─────────────────────────────────────────────────────────────────

  describe('when automation does not exist', () => {
    beforeEach(() => {
      // deleteAutomation returns false → automation not found
      mockDeleteAutomation.mockResolvedValue(false);
    });

    it('returns HTTP 404', async () => {
      const res = await DELETE(fakeRequest, makeContext('ghost-job'));
      expect(res.status).toBe(404);
    });

    it('returns an error body', async () => {
      const res = await DELETE(fakeRequest, makeContext('ghost-job'));
      const body = await res.json();
      expect(body).toHaveProperty('error');
    });

    it('still disables cron before checking existence', async () => {
      await DELETE(fakeRequest, makeContext('ghost-job'));
      // The flag may outlive the file, so it is always cleared.
      expect(mockSetCronEnabled).toHaveBeenCalledWith('ghost-job', false);
    });
  });

  describe('when setCronEnabled throws', () => {
    beforeEach(() => {
      mockSetCronEnabled.mockRejectedValue(new Error('DB unavailable'));
      mockDeleteAutomation.mockResolvedValue(true);
    });

    it('still returns { deleted: true }', async () => {
      const res = await DELETE(fakeRequest, makeContext('my-job'));
      const body = await res.json();
      expect(body).toEqual({ deleted: true });
    });

    it('still calls deleteAutomation', async () => {
      await DELETE(fakeRequest, makeContext('my-job'));
      expect(mockDeleteAutomation).toHaveBeenCalledWith('my-job');
    });
  });
});
