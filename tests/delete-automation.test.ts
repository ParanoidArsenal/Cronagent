/**
 * Tests for the DELETE /api/automations/[name] handler in
 * web/app/api/automations/[name]/route.ts.
 *
 * The handler is responsible for:
 *   1. Calling scheduler.stopOne() to halt any running cron job
 *   2. Calling setCronEnabled(name, false) to disable persisted state
 *   3. Proceeding with deletion even when the scheduler throws (e.g.
 *      web-only mode without a scheduler process)
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

  it('imports getScheduler from @/lib/backend', () => {
    expect(ROUTE_SOURCE).toMatch(
      /import\s*\{[^}]*getScheduler[^}]*\}\s*from\s*['"]@\/lib\/backend['"]/,
    );
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

  // ── scheduler.stopOne call ──────────────────────────────────────────────────

  it('calls scheduler.stopOne', () => {
    expect(ROUTE_SOURCE).toContain('scheduler.stopOne');
  });

  it('calls scheduler.stopOne with the decoded name', () => {
    expect(ROUTE_SOURCE).toMatch(/scheduler\.stopOne\s*\(\s*decodedName\s*\)/);
  });

  // ── setCronEnabled call ─────────────────────────────────────────────────────

  it('calls setCronEnabled', () => {
    expect(ROUTE_SOURCE).toContain('setCronEnabled');
  });

  it('calls setCronEnabled with false to disable the cron state', () => {
    expect(ROUTE_SOURCE).toMatch(/setCronEnabled\s*\(\s*decodedName\s*,\s*false\s*\)/);
  });

  // ── try/catch wrapping ──────────────────────────────────────────────────────

  it('wraps the scheduler block in try/catch', () => {
    // Both 'try' and 'catch' must appear before 'deleteAutomation' in the
    // DELETE function body so that scheduler errors are swallowed.
    const deleteFnStart = ROUTE_LINES.findIndex((l) => l.includes('export async function DELETE'));
    expect(deleteFnStart).toBeGreaterThan(-1);

    const bodyLines = ROUTE_LINES.slice(deleteFnStart);
    const tryIdx = bodyLines.findIndex((l) => /\btry\b/.test(l));
    const catchIdx = bodyLines.findIndex((l) => /\bcatch\b/.test(l));
    const deleteCallIdx = bodyLines.findIndex((l) => l.includes('deleteAutomation'));

    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    // deleteAutomation must come AFTER the catch — meaning the try/catch
    // wraps only the scheduler block, not the deletion itself.
    expect(deleteCallIdx).toBeGreaterThan(catchIdx);
  });

  it('stopOne is called inside the try block (before the catch)', () => {
    const deleteFnStart = ROUTE_LINES.findIndex((l) => l.includes('export async function DELETE'));
    const bodyLines = ROUTE_LINES.slice(deleteFnStart);

    const tryIdx = bodyLines.findIndex((l) => /\btry\b/.test(l));
    const catchIdx = bodyLines.findIndex((l) => /\bcatch\b/.test(l));
    const stopOneIdx = bodyLines.findIndex((l) => l.includes('scheduler.stopOne'));

    expect(stopOneIdx).toBeGreaterThan(tryIdx);
    expect(stopOneIdx).toBeLessThan(catchIdx);
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

  // ── Ordering: stop before delete ────────────────────────────────────────────

  it('calls stopOne before deleteAutomation', () => {
    const stopOneIdx = ROUTE_SOURCE.indexOf('scheduler.stopOne');
    const deleteCallIdx = ROUTE_SOURCE.indexOf('deleteAutomation(');
    expect(stopOneIdx).toBeGreaterThan(-1);
    expect(deleteCallIdx).toBeGreaterThan(-1);
    expect(stopOneIdx).toBeLessThan(deleteCallIdx);
  });

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

const mockStopOne = vi.fn();
const mockGetScheduler = vi.fn().mockResolvedValue({ stopOne: mockStopOne });
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
  Scheduler: vi.fn().mockImplementation(() => ({})),
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

// ── Intercept @/lib/backend so we can control getScheduler, etc. ─────────────
//
// The route file imports from '@/lib/backend'. There is no '@/' alias in
// vitest.config.ts, so Vitest resolves it via Next.js tsconfig path mapping.
// We mock the module path that the bundler resolves to.

vi.mock('../web/lib/backend.ts', async (importOriginal) => {
  // Pull in the real module so parseAutomationInput etc. still work if needed.
  // For this test suite we only need to override the four functions the DELETE
  // handler calls.
  const real = await importOriginal<typeof import('../web/lib/backend.ts')>();
  return {
    ...real,
    getScheduler: (...args: unknown[]) => mockGetScheduler(...args),
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

    // Default: scheduler is healthy and returns a stub with stopOne
    mockGetScheduler.mockResolvedValue({ stopOne: mockStopOne });
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

    it('calls scheduler.stopOne with the automation name', async () => {
      await DELETE(fakeRequest, makeContext('my-job'));
      expect(mockStopOne).toHaveBeenCalledWith('my-job');
    });

    it('calls setCronEnabled(name, false)', async () => {
      await DELETE(fakeRequest, makeContext('my-job'));
      expect(mockSetCronEnabled).toHaveBeenCalledWith('my-job', false);
    });

    it('calls stopOne before deleteAutomation', async () => {
      const callOrder: string[] = [];
      mockStopOne.mockImplementation(() => { callOrder.push('stopOne'); });
      mockDeleteAutomation.mockImplementation(() => { callOrder.push('deleteAutomation'); return Promise.resolve(true); });

      await DELETE(fakeRequest, makeContext('my-job'));

      expect(callOrder.indexOf('stopOne')).toBeLessThan(callOrder.indexOf('deleteAutomation'));
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
      expect(mockStopOne).toHaveBeenCalledWith('my job');
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

    it('still attempts to stop the scheduler before checking existence', async () => {
      await DELETE(fakeRequest, makeContext('ghost-job'));
      // Scheduler cleanup should always be attempted regardless of whether
      // the file exists, because the cron job might still be registered.
      expect(mockStopOne).toHaveBeenCalledTimes(1);
    });
  });

  // ── Graceful fallback when scheduler throws ──────────────────────────────────

  describe('when scheduler.getScheduler throws', () => {
    beforeEach(() => {
      mockGetScheduler.mockRejectedValue(new Error('Scheduler not initialized'));
      mockDeleteAutomation.mockResolvedValue(true);
    });

    it('still returns { deleted: true } (scheduler error is swallowed)', async () => {
      const res = await DELETE(fakeRequest, makeContext('my-job'));
      const body = await res.json();
      expect(body).toEqual({ deleted: true });
    });

    it('still returns HTTP 200', async () => {
      const res = await DELETE(fakeRequest, makeContext('my-job'));
      expect(res.status).toBe(200);
    });

    it('still calls deleteAutomation after the scheduler error', async () => {
      await DELETE(fakeRequest, makeContext('my-job'));
      expect(mockDeleteAutomation).toHaveBeenCalledWith('my-job');
    });
  });

  describe('when scheduler.stopOne throws', () => {
    beforeEach(() => {
      mockStopOne.mockImplementation(() => { throw new Error('stopOne failed'); });
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
