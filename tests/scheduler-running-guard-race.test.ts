/**
 * Unit tests for Scheduler running-guard race condition fix.
 *
 * Verifies that `this.running.add()` happens synchronously after `this.running.has()`,
 * before any `await` calls, preventing duplicate concurrent runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Automation } from '@cronagent/types';

// ── Mock croner ──────────────────────────────────────────────────────────────
const cronCallbacks: Array<() => Promise<void>> = [];
vi.mock('croner', () => {
  class MockCron {
    stop = vi.fn();
    nextRun = vi.fn().mockReturnValue(null);
    getPattern = vi.fn().mockReturnValue('* * * * *');
    constructor(_pattern: string, cb: () => Promise<void>) {
      cronCallbacks.push(cb);
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

// ── Mock usage-tracker ────────────────────────────────────────────────────────
vi.mock('./usage-tracker.js', () => {
  class MockUsageTracker {
    checkBudget = vi.fn().mockResolvedValue({ allowed: true });
  }
  return { UsageTracker: MockUsageTracker };
});

// ── Mock history ─────────────────────────────────────────────────────────────
const mockGetSetting = vi.fn().mockResolvedValue(null);
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
    DEFAULT_THROTTLE: {
      maxConcurrent: 3,
      maxPerHour: 20,
      cooldownSeconds: 0,
      enabled: false,
    },
    DEFAULT_BUDGET: {
      enabled: false,
      dailyBudget: 10,
      reservePercent: 10,
      workHoursStart: 9,
      workHoursEnd: 17,
      offHoursMultiplier: 0.5,
    },
    ThrottleConfigSchema: z.object({
      maxConcurrent: z.number().int().min(1).max(100),
      maxPerHour: z.number().int().min(0).max(10000),
      cooldownSeconds: z.number().int().min(0).max(86400),
      enabled: z.boolean(),
    }),
    BudgetConfigSchema: z.object({
      enabled: z.boolean(),
      dailyBudget: z.number(),
      reservePercent: z.number(),
      workHoursStart: z.number(),
      workHoursEnd: z.number(),
      offHoursMultiplier: z.number(),
    }),
  };
});

// ── Import after mocks ───────────────────────────────────────────────────────
import { Scheduler } from '../src/scheduler.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── Tests ────────────────────────────────────────────────────────────────────
describe('Scheduler running-guard race condition', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    cronCallbacks.length = 0;
    scheduler = new Scheduler(makeRunner(), makeHistory());
  });

  it('prevents duplicate runs when two cron ticks fire before first await completes', async () => {
    // Arrange: make execute hang so the first run stays in-flight
    let resolveRun!: () => void;
    mockExecute.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveRun = r;
        }).then(() => ({
          automation: 'test-job',
          success: true,
          output: 'ok',
          error: null,
          durationMs: 50,
          costUsd: 0,
          startedAt: new Date(),
        })),
    );

    scheduler.register(makeAutomation());
    const cronCb = cronCallbacks[0]!;

    // Fire two cron ticks back-to-back without awaiting the first.
    // Before the fix, both would pass the has() guard because running.add()
    // happened after async preflight checks.
    const run1 = cronCb();
    const run2 = cronCb();

    // Let microtasks settle
    await new Promise((r) => setTimeout(r, 20));

    // Only one execute call should have been made — the second tick should
    // have been rejected by the running guard.
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Clean up
    resolveRun();
    await run1;
    await run2;
  });

  it('releases the running slot when throttle denies execution', async () => {
    // Make throttle deny via maxPerHour exceeded
    mockGetSetting.mockResolvedValue({
      maxConcurrent: 10,
      maxPerHour: 5,
      cooldownSeconds: 0,
      enabled: true,
    });
    mockGetRunsInWindow.mockResolvedValue(5); // at limit

    scheduler.register(makeAutomation());
    const cronCb = cronCallbacks[0]!;

    // First call: throttled by maxPerHour, should release running slot
    await cronCb();
    expect(mockExecute).not.toHaveBeenCalled();

    // Second call: allow this time — should NOT see "already running"
    mockGetSetting.mockResolvedValue(null); // disable throttle
    await cronCb();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('releases the running slot when budget denies execution', async () => {
    // First call: budget denied
    const { UsageTracker } = await import('../src/usage-tracker.js');
    // Override the mock for this test via the scheduler's internal tracker
    // We access it through the cron callback behavior instead
    const budgetMock = vi.fn()
      .mockResolvedValueOnce({ allowed: false, reason: 'over budget' })
      .mockResolvedValueOnce({ allowed: true });

    // Re-create scheduler with custom budget mock
    const customScheduler = new Scheduler(makeRunner(), makeHistory());
    // Access internal usageTracker to override checkBudget
    (customScheduler as any).usageTracker.checkBudget = budgetMock;

    cronCallbacks.length = 0;
    customScheduler.register(makeAutomation());
    const cronCb = cronCallbacks[0]!;

    // First call: budget denied — should release running slot
    await cronCb();
    expect(mockExecute).not.toHaveBeenCalled();

    // Second call: budget allowed — should NOT see "already running"
    await cronCb();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('releases the running slot on normal completion', async () => {
    scheduler.register(makeAutomation());
    const cronCb = cronCallbacks[0]!;

    // Run completes normally
    await cronCb();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Second run should work fine — slot was released in finally block
    await cronCb();
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
