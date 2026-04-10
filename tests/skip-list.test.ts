/**
 * Unit tests for the SkipList class.
 *
 * The History class is fully mocked so no database is needed.
 * Tests exercise: has(), list(), recordFailure(), recordSuccess(),
 * remove(), clear(), and prePopulate().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { SkipList } from '../src/skip-list.js';
import type { History } from '../src/history.js';
import type { SkipEntry } from '../src/types.js';

// ── Mock History factory ──────────────────────────────────────────────────────

/**
 * Creates a minimal mock of History backed by an in-memory store so that
 * getSetting / setSetting behave like a real key-value bag without a DB.
 */
function makeHistory(
  overrides: Partial<{
    getConsecutiveFailures: (name: string, limit: number) => Promise<number>;
    getFailedTasks: (min: number) => Promise<string[]>;
  }> = {},
): History {
  // Internal in-memory settings store
  const store: Record<string, unknown> = {};

  return {
    getSetting: vi.fn(async <T>(key: string): Promise<T | null> => {
      return (store[key] as T) ?? null;
    }),
    setSetting: vi.fn(async <T>(key: string, value: T): Promise<void> => {
      store[key] = value;
    }),
    getConsecutiveFailures: vi.fn(
      overrides.getConsecutiveFailures ?? (async () => 0),
    ),
    getFailedTasks: vi.fn(overrides.getFailedTasks ?? (async () => [])),
  } as unknown as History;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a SkipEntry shape as stored internally (without automationName key). */
function storedEntry(consecutiveFailures: number, addedAt: string) {
  return { consecutiveFailures, addedAt };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SkipList', () => {
  let history: History;

  beforeEach(() => {
    vi.clearAllMocks();
    history = makeHistory();
  });

  // ── has() ──────────────────────────────────────────────────────────────────

  describe('has()', () => {
    it('returns false when the skip list is empty', async () => {
      const skipList = new SkipList(history);
      expect(await skipList.has('my-automation')).toBe(false);
    });

    it('returns true after an automation has been added', async () => {
      // Pre-seed the settings store via setSetting so the automation is present
      await history.setSetting('skip_list', {
        'my-automation': storedEntry(2, new Date().toISOString()),
      });

      const skipList = new SkipList(history);
      expect(await skipList.has('my-automation')).toBe(true);
    });

    it('returns false for an automation not on the list when others are present', async () => {
      await history.setSetting('skip_list', {
        'other-automation': storedEntry(3, new Date().toISOString()),
      });

      const skipList = new SkipList(history);
      expect(await skipList.has('my-automation')).toBe(false);
    });
  });

  // ── list() ─────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns an empty array when no automations are on the skip list', async () => {
      const skipList = new SkipList(history);
      const entries = await skipList.list();
      expect(entries).toEqual([]);
    });

    it('returns a SkipEntry for each automation on the list', async () => {
      const addedAt = '2026-04-01T00:00:00.000Z';
      await history.setSetting('skip_list', {
        'automation-a': storedEntry(2, addedAt),
        'automation-b': storedEntry(4, addedAt),
      });

      const skipList = new SkipList(history);
      const entries = await skipList.list();

      expect(entries).toHaveLength(2);

      const names = entries.map((e: SkipEntry) => e.automationName).sort();
      expect(names).toEqual(['automation-a', 'automation-b']);

      const entryA = entries.find((e: SkipEntry) => e.automationName === 'automation-a')!;
      expect(entryA.consecutiveFailures).toBe(2);
      expect(entryA.addedAt).toBe(addedAt);
    });
  });

  // ── recordFailure() ────────────────────────────────────────────────────────

  describe('recordFailure()', () => {
    it('adds the automation to the skip list when failures reach the threshold', async () => {
      // Threshold defaults to 2; return exactly 2 consecutive failures
      history = makeHistory({ getConsecutiveFailures: async () => 2 });
      const skipList = new SkipList(history);

      await skipList.recordFailure('flaky-job');

      expect(await skipList.has('flaky-job')).toBe(true);
    });

    it('adds the automation when failures exceed the threshold', async () => {
      history = makeHistory({ getConsecutiveFailures: async () => 5 });
      const skipList = new SkipList(history);

      await skipList.recordFailure('broken-job');

      expect(await skipList.has('broken-job')).toBe(true);
    });

    it('does NOT add the automation when failures are below the threshold', async () => {
      // Only 1 consecutive failure — below the default threshold of 2
      history = makeHistory({ getConsecutiveFailures: async () => 1 });
      const skipList = new SkipList(history);

      await skipList.recordFailure('almost-failing-job');

      expect(await skipList.has('almost-failing-job')).toBe(false);
    });

    it('does NOT add the automation when there are zero failures', async () => {
      history = makeHistory({ getConsecutiveFailures: async () => 0 });
      const skipList = new SkipList(history);

      await skipList.recordFailure('healthy-job');

      expect(await skipList.has('healthy-job')).toBe(false);
    });

    it('does not add a duplicate entry when automation is already on the list', async () => {
      history = makeHistory({ getConsecutiveFailures: async () => 3 });
      const skipList = new SkipList(history);

      // Add once
      await skipList.recordFailure('repeated-job');
      // setSetting should have been called once to write the entry
      const callsAfterFirst = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;

      // Record failure again — entry already present, no second write expected
      await skipList.recordFailure('repeated-job');
      const callsAfterSecond = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    it('respects a custom threshold supplied at construction', async () => {
      // Custom threshold of 3
      history = makeHistory({ getConsecutiveFailures: async () => 2 });
      const skipList = new SkipList(history, 3);

      await skipList.recordFailure('custom-threshold-job');

      // 2 failures < threshold of 3 — should NOT be added
      expect(await skipList.has('custom-threshold-job')).toBe(false);
    });

    it('adds the automation when failures equal a custom threshold', async () => {
      history = makeHistory({ getConsecutiveFailures: async () => 3 });
      const skipList = new SkipList(history, 3);

      await skipList.recordFailure('custom-threshold-job');

      expect(await skipList.has('custom-threshold-job')).toBe(true);
    });

    it('persists the consecutive failure count in the entry', async () => {
      history = makeHistory({ getConsecutiveFailures: async () => 4 });
      const skipList = new SkipList(history);

      await skipList.recordFailure('count-check-job');

      const entries = await skipList.list();
      const entry = entries.find((e: SkipEntry) => e.automationName === 'count-check-job')!;
      expect(entry.consecutiveFailures).toBe(4);
    });

    it('records a non-empty ISO addedAt timestamp', async () => {
      history = makeHistory({ getConsecutiveFailures: async () => 2 });
      const skipList = new SkipList(history);

      const before = new Date().toISOString();
      await skipList.recordFailure('timestamp-job');
      const after = new Date().toISOString();

      const entries = await skipList.list();
      const entry = entries.find((e: SkipEntry) => e.automationName === 'timestamp-job')!;
      expect(entry.addedAt >= before).toBe(true);
      expect(entry.addedAt <= after).toBe(true);
    });
  });

  // ── recordSuccess() ────────────────────────────────────────────────────────

  describe('recordSuccess()', () => {
    it('removes the automation from the skip list on success', async () => {
      await history.setSetting('skip_list', {
        'recovering-job': storedEntry(2, new Date().toISOString()),
      });

      const skipList = new SkipList(history);
      await skipList.recordSuccess('recovering-job');

      expect(await skipList.has('recovering-job')).toBe(false);
    });

    it('does not modify settings when the automation is not on the list', async () => {
      const skipList = new SkipList(history);

      // No entry exists — setSetting should not be called at all
      const callsBefore = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;
      await skipList.recordSuccess('absent-job');
      const callsAfter = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
    });

    it('only removes the targeted automation, leaving others intact', async () => {
      await history.setSetting('skip_list', {
        'job-to-clear': storedEntry(2, new Date().toISOString()),
        'job-to-keep': storedEntry(3, new Date().toISOString()),
      });

      const skipList = new SkipList(history);
      await skipList.recordSuccess('job-to-clear');

      expect(await skipList.has('job-to-clear')).toBe(false);
      expect(await skipList.has('job-to-keep')).toBe(true);
    });
  });

  // ── remove() ──────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('removes the named automation from the skip list', async () => {
      await history.setSetting('skip_list', {
        'to-remove': storedEntry(2, new Date().toISOString()),
        'to-stay': storedEntry(2, new Date().toISOString()),
      });

      const skipList = new SkipList(history);
      await skipList.remove('to-remove');

      expect(await skipList.has('to-remove')).toBe(false);
      expect(await skipList.has('to-stay')).toBe(true);
    });

    it('is a no-op when the automation is not on the list', async () => {
      const skipList = new SkipList(history);

      const callsBefore = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;
      await skipList.remove('never-there');
      const callsAfter = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
    });
  });

  // ── clear() ───────────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('removes all automations from the skip list', async () => {
      await history.setSetting('skip_list', {
        'job-a': storedEntry(2, new Date().toISOString()),
        'job-b': storedEntry(3, new Date().toISOString()),
      });

      const skipList = new SkipList(history);
      await skipList.clear();

      expect(await skipList.list()).toEqual([]);
    });

    it('persists an empty object via setSetting', async () => {
      const skipList = new SkipList(history);
      await skipList.clear();

      const calls = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('skip_list');
      expect(lastCall[1]).toEqual({});
    });

    it('leaves the list empty when called on an already-empty list', async () => {
      const skipList = new SkipList(history);
      await skipList.clear();

      expect(await skipList.list()).toEqual([]);
    });
  });

  // ── prePopulate() ─────────────────────────────────────────────────────────

  describe('prePopulate()', () => {
    it('does nothing when there are no failed tasks in history', async () => {
      history = makeHistory({ getFailedTasks: async () => [] });
      const skipList = new SkipList(history);

      const callsBefore = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;
      await skipList.prePopulate();
      const callsAfter = (history.setSetting as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
    });

    it('adds all failed tasks to the skip list', async () => {
      history = makeHistory({
        getFailedTasks: async () => ['job-x', 'job-y'],
        getConsecutiveFailures: async () => 3,
      });
      const skipList = new SkipList(history);

      await skipList.prePopulate();

      expect(await skipList.has('job-x')).toBe(true);
      expect(await skipList.has('job-y')).toBe(true);
    });

    it('uses getConsecutiveFailures to record failure counts for each seeded task', async () => {
      const failureCounts: Record<string, number> = {
        'job-a': 5,
        'job-b': 2,
      };
      history = makeHistory({
        getFailedTasks: async () => ['job-a', 'job-b'],
        getConsecutiveFailures: async (name: string) => failureCounts[name] ?? 0,
      });
      const skipList = new SkipList(history);

      await skipList.prePopulate();

      const entries = await skipList.list();
      const entryA = entries.find((e: SkipEntry) => e.automationName === 'job-a')!;
      const entryB = entries.find((e: SkipEntry) => e.automationName === 'job-b')!;

      expect(entryA.consecutiveFailures).toBe(5);
      expect(entryB.consecutiveFailures).toBe(2);
    });

    it('does not overwrite automations already on the skip list', async () => {
      const existingAddedAt = '2026-01-01T00:00:00.000Z';
      await history.setSetting('skip_list', {
        'existing-job': storedEntry(7, existingAddedAt),
      });

      history = {
        ...history,
        getFailedTasks: vi.fn(async () => ['existing-job', 'new-job']),
        getConsecutiveFailures: vi.fn(async () => 2),
      } as unknown as History;

      const skipList = new SkipList(history);

      // Pre-seed so getEntries returns the existing entry
      await history.setSetting('skip_list', {
        'existing-job': storedEntry(7, existingAddedAt),
      });

      await skipList.prePopulate();

      const entries = await skipList.list();
      const existing = entries.find((e: SkipEntry) => e.automationName === 'existing-job')!;

      // Original entry should be preserved (not overwritten)
      expect(existing.consecutiveFailures).toBe(7);
      expect(existing.addedAt).toBe(existingAddedAt);
    });

    it('calls getFailedTasks with the configured threshold', async () => {
      const getFailedTasks = vi.fn(async () => [] as string[]);
      history = { ...makeHistory(), getFailedTasks } as unknown as History;

      const skipList = new SkipList(history, 5);
      await skipList.prePopulate();

      expect(getFailedTasks).toHaveBeenCalledWith(5);
    });
  });
});
