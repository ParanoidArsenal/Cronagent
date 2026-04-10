/**
 * Tests for orphan run notification.
 *
 * When the daemon or web restarts, in-flight runs are orphaned. The History
 * sweep marks them as failed and stores them in pendingOrphanNotifications.
 * Callers must drain that buffer and notify, otherwise users get no Telegram
 * message about crashed runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock logger ──────────────────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock pg Pool ─────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockEnd = vi.fn(async () => {});

vi.mock('pg', () => {
  class Pool {
    query: typeof mockQuery;
    end: typeof mockEnd;
    constructor() {
      this.query = mockQuery;
      this.end = mockEnd;
    }
  }
  return { default: { Pool } };
});

// ── Imports under test ───────────────────────────────────────────────────────

import { History } from '../src/history.js';
import type { SweptOrphanRow } from '../src/history.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Set up the pg mock so SCHEMA query and sweep return predictable values. */
function setupQueryMock(sweepRows: SweptOrphanRow[]) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE') || sql.includes('CREATE INDEX')) {
      // SCHEMA query — multi-statement, no result rows expected
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (sql.includes('UPDATE run_history') && sql.includes('RETURNING')) {
      return Promise.resolve({ rows: sweepRows, rowCount: sweepRows.length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

function makeOrphanRow(overrides: Partial<SweptOrphanRow> = {}): SweptOrphanRow {
  return {
    id: 1,
    automation_name: 'test-auto',
    mode: 'claude',
    started_at: new Date('2026-04-06T10:00:00Z'),
    finished_at: new Date('2026-04-06T10:00:30Z'),
    error: 'process crash',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('History orphan sweep — full sweep (daemon)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores swept rows in pending notifications when sweepOrphans is true', async () => {
    const orphans = [
      makeOrphanRow({ id: 1, automation_name: 'standup' }),
      makeOrphanRow({ id: 2, automation_name: 'check-jira-tasks' }),
    ];
    setupQueryMock(orphans);

    const history = await History.create('postgres://localhost/test', { sweepOrphans: true });
    const pending = history.takePendingOrphanNotifications();

    expect(pending).toHaveLength(2);
    expect(pending[0].automation_name).toBe('standup');
    expect(pending[1].automation_name).toBe('check-jira-tasks');
  });

  it('uses RETURNING in the full-sweep UPDATE query', async () => {
    setupQueryMock([]);
    await History.create('postgres://localhost/test', { sweepOrphans: true });

    const updateCall = mockQuery.mock.calls.find((c: unknown[]) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE run_history') && !sql.includes('30 minutes');
    });
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain('RETURNING');
  });

  it('stores empty array when no rows were swept', async () => {
    setupQueryMock([]);
    const history = await History.create('postgres://localhost/test', { sweepOrphans: true });
    expect(history.takePendingOrphanNotifications()).toEqual([]);
  });
});

describe('History orphan sweep — stale sweep (web)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores swept stale rows in pending notifications when sweepOrphans is false', async () => {
    const orphans = [makeOrphanRow({ id: 99, error: 'process crash (stale)' })];
    setupQueryMock(orphans);

    const history = await History.create('postgres://localhost/test'); // no opts → stale-only sweep
    const pending = history.takePendingOrphanNotifications();

    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(99);
    expect(pending[0].error).toBe('process crash (stale)');
  });

  it('uses 30-minute threshold and RETURNING in the stale-sweep query', async () => {
    setupQueryMock([]);
    await History.create('postgres://localhost/test');

    const updateCall = mockQuery.mock.calls.find((c: unknown[]) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE run_history') && sql.includes('30 minutes');
    });
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toContain('RETURNING');
  });
});

describe('History.takePendingOrphanNotifications()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is idempotent — second call returns empty array', async () => {
    const orphans = [makeOrphanRow()];
    setupQueryMock(orphans);

    const history = await History.create('postgres://localhost/test', { sweepOrphans: true });
    const first = history.takePendingOrphanNotifications();
    const second = history.takePendingOrphanNotifications();

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('returns each swept row with all required notification fields', async () => {
    const startedAt = new Date('2026-04-06T10:00:00Z');
    const finishedAt = new Date('2026-04-06T10:05:00Z');
    setupQueryMock([
      makeOrphanRow({
        id: 42,
        automation_name: 'standup',
        mode: 'claude',
        started_at: startedAt,
        finished_at: finishedAt,
        error: 'process crash',
      }),
    ]);

    const history = await History.create('postgres://localhost/test', { sweepOrphans: true });
    const pending = history.takePendingOrphanNotifications();
    const row = pending[0];

    expect(row.id).toBe(42);
    expect(row.automation_name).toBe('standup');
    expect(row.mode).toBe('claude');
    expect(row.started_at).toEqual(startedAt);
    expect(row.finished_at).toEqual(finishedAt);
    expect(row.error).toBe('process crash');
  });
});
