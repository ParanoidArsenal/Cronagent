/**
 * Unit tests for Scheduler throttle enforcement.
 *
 * Mocks Runner, History, and croner to test throttle logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ThrottleConfig } from '@cronagent/history';
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

const makeThrottle = (overrides: Partial<ThrottleConfig> = {}): ThrottleConfig => ({
  maxConcurrent: 3,
  maxPerHour: 20,
  cooldownSeconds: 0,
  enabled: true,
  ...overrides,
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

describe('Scheduler throttle', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    cronCallback = null;
    scheduler = new Scheduler(makeRunner(), makeHistory());
  });

  it('runs normally when throttle is disabled', async () => {
    mockGetSetting.mockResolvedValue(null); // falls back to DEFAULT_THROTTLE (disabled)

    scheduler.register(makeAutomation());
    expect(cronCallback).not.toBeNull();

    await cronCallback!();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockInsertRunning).toHaveBeenCalledTimes(1);
    expect(mockFinalizeRun).toHaveBeenCalledTimes(1);
  });

  it('runs normally when throttle is enabled but limits not exceeded', async () => {
    mockGetSetting.mockResolvedValue(makeThrottle());
    mockGetRunsInWindow.mockResolvedValue(0);

    scheduler.register(makeAutomation());
    await cronCallback!();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('blocks when maxConcurrent is exceeded', async () => {
    mockGetSetting.mockResolvedValue(makeThrottle({ maxConcurrent: 1 }));

    // First job: execute returns a pending promise (simulates a long run)
    let resolveFirst!: () => void;
    mockExecute.mockImplementationOnce(() => new Promise((r) => {
      resolveFirst = () => r({ automation: 'job-a', success: true, output: 'ok', error: null, durationMs: 100, costUsd: 0, startedAt: new Date() });
    }));

    scheduler.register(makeAutomation('job-a'));
    const cronCallbackA = cronCallback!;

    scheduler.register(makeAutomation('job-b'));
    const cronCallbackB = cronCallback!;

    // Start first job — let microtasks settle so it passes throttle and enters running set
    const firstRun = cronCallbackA();
    await new Promise((r) => setTimeout(r, 10));

    // Now first job is in running set. Second job should be throttled.
    await cronCallbackB();

    // Only first job should have called execute
    expect(mockExecute).toHaveBeenCalledTimes(1);

    resolveFirst();
    await firstRun;
  });

  it('blocks when maxPerHour is exceeded', async () => {
    mockGetSetting.mockResolvedValue(makeThrottle({ maxPerHour: 5 }));
    mockGetRunsInWindow.mockResolvedValue(5); // already at limit

    scheduler.register(makeAutomation());
    await cronCallback!();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('blocks during cooldown period', async () => {
    mockGetSetting.mockResolvedValue(makeThrottle({ cooldownSeconds: 60 }));
    mockGetRunsInWindow.mockResolvedValue(0);

    scheduler.register(makeAutomation());

    // First run succeeds
    await cronCallback!();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Second run immediately after should be throttled (cooldown 60s)
    mockExecute.mockClear();
    await cronCallback!();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('skips execution when insertRunning returns null (DB unique constraint)', async () => {
    mockGetSetting.mockResolvedValue(null);
    mockInsertRunning.mockResolvedValueOnce(null); // simulate unique violation

    scheduler.register(makeAutomation());
    await cronCallback!();

    // Runner should never be called
    expect(mockExecute).not.toHaveBeenCalled();
    // finalizeRun should never be called (no row to finalize)
    expect(mockFinalizeRun).not.toHaveBeenCalled();
  });

  it('allows run after cooldown expires', async () => {
    mockGetSetting.mockResolvedValue(makeThrottle({ cooldownSeconds: 1 }));
    mockGetRunsInWindow.mockResolvedValue(0);

    scheduler.register(makeAutomation());

    // First run
    await cronCallback!();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 1100));

    mockExecute.mockClear();
    await cronCallback!();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
