/**
 * Unit tests for the per-automation cron_enabled flag.
 *
 * The daemon constructs the Scheduler with honorCronFlags so that start/stop
 * in the web UI (which only flips the setting) takes effect on the next tick.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Automation } from '@cronagent/types';

// ── Mock croner ──────────────────────────────────────────────────────────────
// Capture the cron callback so we can invoke it manually.
let cronCallback: (() => Promise<void>) | null = null;
vi.mock('croner', () => {
  class MockCron {
    stop = vi.fn();
    nextRun = vi.fn().mockReturnValue(null);
    getPattern = vi.fn().mockReturnValue('* * * * *');
    constructor(_pattern: string, cb: () => Promise<void>) {
      cronCallback = cb;
    }
  }
  return { Cron: MockCron };
});

// ── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock runner ──────────────────────────────────────────────────────────────
const mockExecute = vi.fn().mockResolvedValue({
  automation: 'test-job',
  success: true,
  output: 'ok',
  error: null,
  durationMs: 100,
  costUsd: 0,
  startedAt: new Date(),
});

vi.mock('./runner.js', () => {
  class MockRunner { execute = mockExecute; }
  return { Runner: MockRunner };
});

// ── Mock history ─────────────────────────────────────────────────────────────
const mockGetSetting = vi.fn();
const mockInsert = vi.fn().mockResolvedValue(1);
const mockInsertRunning = vi.fn().mockResolvedValue(1);
const mockFinalizeRun = vi.fn().mockResolvedValue(undefined);
const mockUpdateProgress = vi.fn().mockResolvedValue(undefined);
const mockGetRunsInWindow = vi.fn().mockResolvedValue(0);

vi.mock('./history.js', () => {
  class MockHistory {
    getSetting = mockGetSetting;
    insert = mockInsert;
    insertRunning = mockInsertRunning;
    finalizeRun = mockFinalizeRun;
    updateProgress = mockUpdateProgress;
    getRunsInWindow = mockGetRunsInWindow;
  }
  return {
    History: MockHistory,
    DEFAULT_THROTTLE: { maxConcurrent: 3, maxPerHour: 20, cooldownSeconds: 0, enabled: false },
    ThrottleConfigSchema: z.object({
      maxConcurrent: z.number().int().min(1).max(100),
      maxPerHour: z.number().int().min(0).max(10000),
      cooldownSeconds: z.number().int().min(0).max(86400),
      enabled: z.boolean(),
    }),
  };
});

// ── Import after mocks ──────────────────────────────────────────────────────
import { Scheduler } from '../src/scheduler.js';

const makeAutomation = (name = 'test-job'): Automation => ({
  name,
  description: 'test',
  trigger: 'cron',
  schedule: '* * * * *',
  model: 'opus',
  instructions: 'do stuff',
});

const makeRunner = () => ({ execute: mockExecute }) as any;
const makeHistory = () => ({
  getSetting: mockGetSetting,
  insert: mockInsert,
  insertRunning: mockInsertRunning,
  finalizeRun: mockFinalizeRun,
  updateProgress: mockUpdateProgress,
  getRunsInWindow: mockGetRunsInWindow,
}) as any;

/** Resolve `cron_enabled::<name>` to `flag`; everything else (throttle) unset. */
const withFlag = (flag: unknown) =>
  mockGetSetting.mockImplementation(async (key: string) =>
    key.startsWith('cron_enabled::') ? flag : null,
  );

describe('Scheduler cron_enabled flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cronCallback = null;
  });

  describe('with honorCronFlags', () => {
    let scheduler: Scheduler;
    beforeEach(() => {
      scheduler = new Scheduler(makeRunner(), makeHistory(), undefined, undefined, { honorCronFlags: true });
    });

    it('runs when the flag is true', async () => {
      withFlag(true);
      scheduler.register(makeAutomation());
      await cronCallback!();
      expect(mockGetSetting).toHaveBeenCalledWith('cron_enabled::test-job');
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('skips when the flag is false', async () => {
      withFlag(false);
      scheduler.register(makeAutomation());
      await cronCallback!();
      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockInsertRunning).not.toHaveBeenCalled();
    });

    it('skips when the flag was never set', async () => {
      withFlag(null);
      scheduler.register(makeAutomation());
      await cronCallback!();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('skips (and does not wedge the running slot) when reading the flag fails', async () => {
      mockGetSetting.mockRejectedValueOnce(new Error('db down'));
      scheduler.register(makeAutomation());
      await cronCallback!();
      expect(mockExecute).not.toHaveBeenCalled();

      // Next tick with the flag readable runs normally — the slot was released.
      withFlag(true);
      await cronCallback!();
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('picks up a toggle between ticks without re-registering', async () => {
      withFlag(true);
      scheduler.register(makeAutomation());
      await cronCallback!();
      withFlag(false);
      await cronCallback!();
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  it('ignores the flag when honorCronFlags is off (default)', async () => {
    const scheduler = new Scheduler(makeRunner(), makeHistory());
    withFlag(false);
    scheduler.register(makeAutomation());
    await cronCallback!();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
