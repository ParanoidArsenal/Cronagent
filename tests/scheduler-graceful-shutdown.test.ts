/**
 * Unit tests for Scheduler graceful shutdown feature.
 *
 * Tests cover:
 *  - shutdown() sets the shuttingDown flag and stops all cron jobs
 *  - cron callback returns early (skips execution) when shuttingDown is true
 *  - waitForIdle() resolves immediately when no runs are in-flight
 *  - waitForIdle() waits for an in-flight run to finish before resolving
 *  - waitForIdle() resolves after the timeout even if runs are still in-flight
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ThrottleConfig } from '@cronagent/history';
import type { Automation } from '@cronagent/types';

// ── Mock croner ──────────────────────────────────────────────────────────────
// Each call to new Cron() pushes its callback into the array so that
// tests can register multiple automations and invoke each callback independently.
const cronCallbacks: Array<() => Promise<void>> = [];
const mockCronStop = vi.fn();

vi.mock('croner', () => {
  class MockCron {
    stop = mockCronStop;
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
// Always allow — budget logic is tested separately.
vi.mock('./usage-tracker.js', () => {
  class MockUsageTracker {
    checkBudget = vi.fn().mockResolvedValue({ allowed: true });
  }
  return { UsageTracker: MockUsageTracker };
});

// ── Mock history ─────────────────────────────────────────────────────────────
const mockGetSetting = vi.fn().mockResolvedValue(null); // disabled throttle
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
describe('Scheduler graceful shutdown', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    cronCallbacks.length = 0;
    scheduler = new Scheduler(makeRunner(), makeHistory());
  });

  // ── Test 1 ────────────────────────────────────────────────────────────────
  it('shutdown() stops all crons and sets shuttingDown flag', async () => {
    scheduler.register(makeAutomation('job-a'));
    scheduler.register(makeAutomation('job-b'));

    // Both crons were registered and their callbacks captured.
    expect(cronCallbacks).toHaveLength(2);

    scheduler.shutdown();

    // stop() is called once per cron job (two jobs registered).
    expect(mockCronStop).toHaveBeenCalledTimes(2);

    // After shutdown the cron callbacks must not trigger execution.
    await cronCallbacks[0]!();
    await cronCallbacks[1]!();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  it('waitForIdle() resolves immediately when no runs are in-flight', async () => {
    const start = Date.now();
    // 5 000 ms timeout — should resolve well before that with zero in-flight runs.
    await scheduler.waitForIdle(5_000);
    expect(Date.now() - start).toBeLessThan(100);
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  it('waitForIdle() waits for an in-flight run to complete then resolves', async () => {
    // Arrange: execute returns a promise we control.
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

    // Kick off the cron callback — it will hang inside mockExecute.
    const runPromise = cronCb();
    // Yield to allow the async cron callback to reach the runner.execute() call
    // and add the job to the running set.
    await new Promise((r) => setTimeout(r, 20));

    // waitForIdle should NOT resolve until the run finishes.
    let idleResolved = false;
    const idlePromise = scheduler.waitForIdle(5_000).then(() => {
      idleResolved = true;
    });

    // Give waitForIdle one polling interval (200 ms) to confirm it is still
    // waiting — the run has not finished yet.
    await new Promise((r) => setTimeout(r, 250));
    expect(idleResolved).toBe(false);

    // Now finish the in-flight run.
    resolveRun();
    await runPromise;

    // waitForIdle should resolve within the next polling cycle.
    await idlePromise;
    expect(idleResolved).toBe(true);
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  it('waitForIdle() resolves after timeout even if runs are still in-flight', async () => {
    // Arrange: execute never resolves — simulates a stuck run.
    mockExecute.mockImplementationOnce(() => new Promise(() => {}));

    scheduler.register(makeAutomation());
    const cronCb = cronCallbacks[0]!;

    // Start the long-running cron tick.
    cronCb(); // intentionally not awaited
    await new Promise((r) => setTimeout(r, 20));

    const start = Date.now();
    // Use a short timeout so the test finishes quickly.
    await scheduler.waitForIdle(400);
    const elapsed = Date.now() - start;

    // Should have resolved at or after the 400 ms deadline.
    expect(elapsed).toBeGreaterThanOrEqual(380);
    // But should not have waited significantly longer than the timeout.
    expect(elapsed).toBeLessThan(1_000);
  });

  // ── Test 5 ────────────────────────────────────────────────────────────────
  it('cron callback skips execution when shuttingDown is true', async () => {
    scheduler.register(makeAutomation());
    const cronCb = cronCallbacks[0]!;

    // Verify the callback executes normally before shutdown.
    await cronCb();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Now shut down and invoke the callback again.
    scheduler.shutdown();
    mockExecute.mockClear();

    await cronCb();

    // The callback must return early — runner must not be called.
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
